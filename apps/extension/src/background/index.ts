// Service worker — owns the global recording session.
// MV3 service workers can shut down on inactivity; we persist state in
// chrome.storage.session so the worker can rehydrate transparently.

import { getSupabase, functionUrl } from "../lib/supabase";
import type {
  CapturedEvent,
  RecordingSessionState,
  RuntimeMessage,
  CoachAsk,
} from "../lib/types";
import { uuid } from "../lib/ids";
import { drainEvents, enqueueEvent, putScreenshot, deleteScreenshot } from "../lib/queue";

const SESSION_KEY = "recording_session";
const FLUSH_INTERVAL_MS = 5000;
const COACH_INTERVAL_MS = 30000;
const MIN_ASK_GAP_MS = 60000;
const MAX_ASKS_PER_RECORDING = 6;

// In-memory event buffer. The service worker can be killed; on wake-up we
// re-load any persisted state and resume. The buffer is best-effort — anything
// in flight when the worker dies is lost (events the content scripts already
// sent) and that's an accepted tradeoff for v1.
let buffer: CapturedEvent[] = [];
let flushTimer: number | null = null;
let coachTimer: number | null = null;

async function loadSession(): Promise<RecordingSessionState | null> {
  const v = await chrome.storage.session.get(SESSION_KEY);
  return (v[SESSION_KEY] as RecordingSessionState) ?? null;
}

async function saveSession(s: RecordingSessionState | null): Promise<void> {
  if (s) await chrome.storage.session.set({ [SESSION_KEY]: s });
  else await chrome.storage.session.remove(SESSION_KEY);
}

// ---- Recording lifecycle ----

async function startRecording(): Promise<RecordingSessionState | null> {
  const sb = getSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) {
    console.warn("[scout] start_recording: not authenticated");
    return null;
  }

  // Create the recording row first so we have a stable id for storage paths.
  const recordingId = uuid();
  const startedAtMs = Date.now();
  const { error } = await sb
    .from("recordings")
    .insert({
      id: recordingId,
      user_id: auth.user.id,
      status: "recording",
      started_at: new Date(startedAtMs).toISOString(),
      meta: { ua: navigator.userAgent, platform: navigator.platform },
    });
  if (error) {
    console.error("[scout] failed to insert recording", error);
    // We still let the user record — events queue locally and flush later.
  }

  const state: RecordingSessionState = {
    recording_id: recordingId,
    user_id: auth.user.id,
    started_at: startedAtMs,
    paused_ms: 0,
    is_paused: false,
    audio_supported: true,
    ask_count: 0,
    last_ask_at: 0,
  };
  await saveSession(state);

  await ensureOffscreen();
  await sendToOffscreen({ type: "offscreen:start_audio" });

  await broadcastToTabs({ type: "content:show_control_bar" });

  startTimers();
  console.log("[scout] recording started", recordingId);
  return state;
}

async function stopRecording(): Promise<void> {
  const state = await loadSession();
  if (!state) return;

  stopTimers();
  await broadcastToTabs({ type: "content:hide_control_bar" });
  await sendToOffscreen({ type: "offscreen:stop_audio" });
  // Audio finalization is async — `offscreen:audio_done` posts back here.

  await flushBuffer();

  const sb = getSupabase();
  const endedAt = Date.now();
  const durationMs = endedAt - state.started_at - state.paused_ms;

  await sb
    .from("recordings")
    .update({
      status: "uploading",
      ended_at: new Date(endedAt).toISOString(),
      duration_ms: durationMs,
    })
    .eq("id", state.recording_id);

  await saveSession(null);
  await chrome.runtime.sendMessage({ type: "popup:state", state: null }).catch(() => {});
  console.log("[scout] recording stopped", state.recording_id);
}

async function pauseRecording(): Promise<void> {
  const state = await loadSession();
  if (!state || state.is_paused) return;
  state.is_paused = true;
  (state as RecordingSessionState & { _pauseStartedAt?: number })._pauseStartedAt = Date.now();
  await saveSession(state);
  stopTimers();
}

async function resumeRecording(): Promise<void> {
  const state = (await loadSession()) as
    | (RecordingSessionState & { _pauseStartedAt?: number })
    | null;
  if (!state || !state.is_paused) return;
  if (state._pauseStartedAt) {
    state.paused_ms += Date.now() - state._pauseStartedAt;
    delete state._pauseStartedAt;
  }
  state.is_paused = false;
  await saveSession(state);
  startTimers();
}

function startTimers(): void {
  stopTimers();
  flushTimer = setInterval(() => void flushBuffer(), FLUSH_INTERVAL_MS) as unknown as number;
  coachTimer = setInterval(() => void runCoachCycle(), COACH_INTERVAL_MS) as unknown as number;
}

function stopTimers(): void {
  if (flushTimer != null) {
    clearInterval(flushTimer as unknown as number);
    flushTimer = null;
  }
  if (coachTimer != null) {
    clearInterval(coachTimer as unknown as number);
    coachTimer = null;
  }
}

// ---- Event ingestion ----

async function onContentEvent(ev: CapturedEvent, sender: chrome.runtime.MessageSender): Promise<void> {
  const state = await loadSession();
  if (!state || state.is_paused) return;

  ev.recording_id = state.recording_id;
  ev.user_id = state.user_id;
  ev.ts_ms = Date.now() - state.started_at - state.paused_ms;

  // Capture a screenshot of the active tab. Some pages (chrome://, pdf viewer)
  // refuse — we degrade gracefully and log a synthetic event.
  const tabId = sender.tab?.id ?? null;
  if (tabId != null && shouldCaptureForKind(ev.kind)) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT, {
        format: "jpeg",
        quality: 70,
      });
      const screenshotId = uuid();
      ev._screenshotDataUrl = dataUrl;
      ev.screenshot_path = `${state.user_id}/${state.recording_id}/${screenshotId}.jpg`;
      await putScreenshot(screenshotId, dataUrl);
    } catch (err) {
      ev.screenshot_path = null;
      buffer.push({
        recording_id: state.recording_id,
        user_id: state.user_id,
        ts_ms: ev.ts_ms,
        kind: "screenshot_failed",
        data: { reason: String((err as Error)?.message || err), original_kind: ev.kind },
        _localId: uuid(),
      });
    }
  }

  buffer.push(ev);
}

function shouldCaptureForKind(kind: string): boolean {
  // High-signal events get a screenshot. Scrolls don't (too noisy).
  return kind !== "scroll" && kind !== "tab_switch";
}

// ---- Flush ----

async function flushBuffer(): Promise<void> {
  if (buffer.length === 0) return;
  const state = await loadSession();
  if (!state) return;

  // Drain anything previously queued first (FIFO).
  await drainEvents(async (rows) => {
    await uploadEvents(rows as CapturedEvent[]);
  });

  const batch = buffer.splice(0, buffer.length);
  try {
    await uploadEvents(batch);
  } catch (err) {
    console.warn("[scout] flush failed, queuing locally", err);
    for (const ev of batch) await enqueueEvent(ev);
  }
}

async function uploadEvents(batch: CapturedEvent[]): Promise<void> {
  if (!batch.length) return;
  const sb = getSupabase();

  // 1. Upload screenshots to Storage in parallel.
  await Promise.all(
    batch.map(async (ev) => {
      if (ev._screenshotDataUrl && ev.screenshot_path) {
        try {
          const blob = dataUrlToBlob(ev._screenshotDataUrl);
          const { error } = await sb.storage
            .from("screenshots")
            .upload(ev.screenshot_path, blob, { contentType: "image/jpeg", upsert: true });
          if (error) throw error;
          // Drop the inline DataURL once stored.
          delete ev._screenshotDataUrl;
          // Best-effort delete from IndexedDB cache.
          const id = ev.screenshot_path.split("/").pop()?.replace(".jpg", "");
          if (id) await deleteScreenshot(id).catch(() => {});
        } catch (err) {
          console.warn("[scout] screenshot upload failed", err);
          ev.screenshot_path = null;
        }
      }
    })
  );

  // 2. Insert event rows.
  const rows = batch.map((ev) => ({
    recording_id: ev.recording_id,
    user_id: ev.user_id,
    ts_ms: ev.ts_ms,
    kind: ev.kind,
    data: ev.data,
    screenshot_path: ev.screenshot_path,
  }));
  const { error } = await sb.from("events").insert(rows);
  if (error) throw error;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, b64] = dataUrl.split(",");
  const mime = /data:([^;]+);base64/.exec(header)?.[1] ?? "image/jpeg";
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

// ---- Coaching loop ----

async function runCoachCycle(): Promise<void> {
  const state = await loadSession();
  if (!state || state.is_paused) return;
  if (state.ask_count >= MAX_ASKS_PER_RECORDING) return;
  if (state.last_ask_at && Date.now() - state.last_ask_at < MIN_ASK_GAP_MS) return;

  const recentEvents = buffer.slice(-15).map((e) => ({ kind: e.kind, ts_ms: e.ts_ms, data: e.data }));
  if (!recentEvents.length) return;

  try {
    const sb = getSupabase();
    const { data: sess } = await sb.auth.getSession();
    if (!sess.session) return;

    const res = await fetch(functionUrl("coach"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sess.session.access_token}`,
      },
      body: JSON.stringify({
        events: recentEvents,
        transcript_tail: "", // v1: live transcription is deferred, so empty
        ask_count: state.ask_count,
      }),
    });
    if (!res.ok) {
      console.warn("[scout] /coach non-OK", res.status);
      return;
    }
    const body = (await res.json()) as CoachAsk;
    if (!body.ask) return;

    // Send to the active tab.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: "content:show_toast", ask: body.ask } satisfies RuntimeMessage).catch(() => {});
    }
    // Log to coach_log.
    await sb.from("coach_log").insert({
      recording_id: state.recording_id,
      asked_at_ms: Date.now() - state.started_at,
      ask_text: body.ask,
    });

    state.last_ask_at = Date.now();
    state.ask_count += 1;
    await saveSession(state);
  } catch (err) {
    console.warn("[scout] coach cycle error", err);
  }
}

// ---- Offscreen document ----

const OFFSCREEN_PATH = "src/offscreen/index.html";

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime
    .getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] })
    .catch(() => [] as chrome.runtime.ExtensionContext[]);
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA" as chrome.offscreen.Reason],
    justification: "Capture microphone for workflow narration.",
  });
}

async function closeOffscreen(): Promise<void> {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    /* not open */
  }
}

async function sendToOffscreen(msg: RuntimeMessage): Promise<void> {
  await chrome.runtime.sendMessage(msg).catch(() => {});
}

// ---- Audio finalization ----

async function onAudioDone(bytes: ArrayBuffer, mimeType: string): Promise<void> {
  const state = await loadSession();
  // The session might already be cleared (stop happened seconds ago) — still upload.
  const sb = getSupabase();
  const { data: auth } = await sb.auth.getUser();
  const userId = state?.user_id ?? auth.user?.id;
  // Look up the most recent uploading recording if no session.
  let recordingId = state?.recording_id;
  if (!recordingId && userId) {
    const { data } = await sb
      .from("recordings")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "uploading")
      .order("started_at", { ascending: false })
      .limit(1);
    recordingId = data?.[0]?.id;
  }
  if (!userId || !recordingId) {
    console.warn("[scout] audio_done without recording context");
    await closeOffscreen();
    return;
  }

  // No audio captured (mic denied, no device, or recorder never started).
  // Skip the upload and let transcribe short-circuit on a null audio_path.
  if (!bytes || bytes.byteLength === 0 || !mimeType) {
    await sb.from("recordings").update({ audio_path: null, status: "transcribing" }).eq("id", recordingId);
    await closeOffscreen();
    triggerTranscribe(recordingId).catch((e) => console.warn("[scout] transcribe trigger failed", e));
    return;
  }

  const ext = mimeType.includes("ogg") ? "ogg" : "webm";
  const path = `${userId}/${recordingId}.${ext}`;
  const { error } = await sb.storage
    .from("audio")
    .upload(path, new Blob([bytes], { type: mimeType }), { contentType: mimeType, upsert: true });
  if (error) {
    console.error("[scout] audio upload failed", error);
    await sb.from("recordings").update({ status: "failed" }).eq("id", recordingId);
    await closeOffscreen();
    return;
  }

  await sb.from("recordings").update({ audio_path: path, status: "transcribing" }).eq("id", recordingId);
  await closeOffscreen();

  // Kick off transcription in the background. Best-effort; popup polls status.
  triggerTranscribe(recordingId).catch((e) => console.warn("[scout] transcribe trigger failed", e));
}

async function triggerTranscribe(recordingId: string): Promise<void> {
  const sb = getSupabase();
  const { data: sess } = await sb.auth.getSession();
  if (!sess.session) return;
  await fetch(functionUrl("transcribe"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sess.session.access_token}` },
    body: JSON.stringify({ recording_id: recordingId }),
  });
}

// ---- Tab lifecycle (cross-tab capture) ----

chrome.tabs.onActivated.addListener(async (info) => {
  const state = await loadSession();
  if (!state || state.is_paused) return;
  const tab = await chrome.tabs.get(info.tabId).catch(() => null);
  buffer.push({
    recording_id: state.recording_id,
    user_id: state.user_id,
    ts_ms: Date.now() - state.started_at - state.paused_ms,
    kind: "tab_switch",
    data: { to_tab_id: info.tabId, to_tab_url: tab?.url ?? null },
    _localId: uuid(),
  });
  // Make sure the new tab has the control bar.
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "content:show_control_bar" } satisfies RuntimeMessage).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await loadSession();
  if (!state) return;
  buffer.push({
    recording_id: state.recording_id,
    user_id: state.user_id,
    ts_ms: Date.now() - state.started_at - state.paused_ms,
    kind: "tab_closed",
    data: { tab_id: tabId },
    _localId: uuid(),
  });
});

chrome.webNavigation?.onCommitted?.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const state = await loadSession();
  if (!state || state.is_paused) return;
  buffer.push({
    recording_id: state.recording_id,
    user_id: state.user_id,
    ts_ms: Date.now() - state.started_at - state.paused_ms,
    kind: "navigation",
    data: { to_url: details.url, navigation_type: details.transitionType },
    _localId: uuid(),
  });
});

// ---- Message router ----

async function broadcastToTabs(msg: RuntimeMessage): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((t) => (t.id ? chrome.tabs.sendMessage(t.id, msg).catch(() => {}) : Promise.resolve()))
  );
}

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "popup:start_recording": {
          const state = await startRecording();
          sendResponse({ state });
          break;
        }
        case "popup:stop_recording": {
          await stopRecording();
          sendResponse({ ok: true });
          break;
        }
        case "popup:pause_recording": {
          await pauseRecording();
          sendResponse({ ok: true });
          break;
        }
        case "popup:resume_recording": {
          await resumeRecording();
          sendResponse({ ok: true });
          break;
        }
        case "popup:get_state": {
          const state = await loadSession();
          sendResponse({ state });
          break;
        }
        case "content:event": {
          await onContentEvent(msg.event, sender);
          sendResponse({ ok: true });
          break;
        }
        case "offscreen:audio_done": {
          await onAudioDone(msg.bytes, msg.mimeType);
          sendResponse({ ok: true });
          break;
        }
        case "offscreen:audio_error": {
          console.warn("[scout] offscreen audio error", msg.error);
          // Mark session as audio-unsupported; recording continues without audio.
          const s = await loadSession();
          if (s) {
            s.audio_supported = false;
            await saveSession(s);
          }
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown_message" });
      }
    } catch (err) {
      console.error("[scout] message handler error", err);
      sendResponse({ ok: false, error: String((err as Error)?.message || err) });
    }
  })();
  return true; // keep sendResponse alive for the async handler
});

// On worker wake, if a recording is in-flight, restart timers.
(async () => {
  const state = await loadSession();
  if (state && !state.is_paused) startTimers();
})();
