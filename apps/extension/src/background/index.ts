// Service worker — owns the global recording session.
// MV3 service workers can shut down on inactivity; we persist state in
// chrome.storage.session so the worker can rehydrate transparently.

import { getSupabase, functionUrl } from "../lib/supabase";
import type {
  CapturedEvent,
  RecordingRow,
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
  } else {
    broadcastRecordingChanged(recordingId, "recording");
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
    event_count: 0,
    shot_count: 0,
  };
  await saveSession(state);

  await ensureOffscreen();
  await sendToOffscreen({ type: "offscreen:start_audio" });

  await broadcastToTabs({ type: "content:show_control_bar" });

  // Reset per-recording capture state so failures and rate limits don't carry
  // across sessions.
  lastCaptureAt = 0;
  lastFailureReason = null;

  startTimers();

  // Capture the initial state of the active tab so even a session with zero
  // user input still yields a visual anchor for the LLM.
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id != null) {
    await captureTabAndQueue(activeTab.id, activeTab.windowId ?? null, "navigation", {
      to_url: activeTab.url ?? null,
      initial: true,
    });
  }

  console.log("[scout] recording started", recordingId);
  return state;
}

async function stopRecording(): Promise<void> {
  const state = await loadSession();
  if (!state) return;

  stopTimers();
  await broadcastToTabs({ type: "content:hide_control_bar" });
  await flushBuffer();

  // Serialize the audio finalize so onAudioDone runs to completion BEFORE we
  // clear the session and exit. Otherwise the parallel 'uploading' update
  // here can overwrite the 'transcribing' update from onAudioDone.
  const sb = getSupabase();
  const endedAt = Date.now();
  const durationMs = endedAt - state.started_at - state.paused_ms;

  // 1. Mark the row as ended + uploading. Single atomic update; no further
  //    writes happen here.
  await sb
    .from("recordings")
    .update({
      status: "uploading",
      ended_at: new Date(endedAt).toISOString(),
      duration_ms: durationMs,
    })
    .eq("id", state.recording_id);
  broadcastRecordingChanged(state.recording_id, "uploading");

  // 2. Tell offscreen to wrap up. We await the response so we know stop()
  //    has finished and audio_done has been *sent* by the time this resolves.
  //    The audio_done message is processed by our own onMessage listener
  //    (onAudioDone) which moves status through transcribing -> ready.
  const audioPromise = waitForAudioDone(state.recording_id, 8000);
  try {
    await chrome.runtime.sendMessage({ type: "offscreen:stop_audio" } satisfies RuntimeMessage);
  } catch {
    /* offscreen may have been closed already; we still wait for audio_done */
  }
  await audioPromise;

  // 3. Now safe to clear session — finalize is done.
  await saveSession(null);
  await chrome.runtime.sendMessage({ type: "popup:state", state: null }).catch(() => {});
  console.log("[scout] recording stopped", state.recording_id);
}

// Resolves when onAudioDone has finished processing for the given recording.
// Times out after timeoutMs to prevent stopRecording from hanging if audio
// finalization gets wedged (offscreen crash etc).
const audioDoneWaiters = new Map<string, () => void>();
function waitForAudioDone(recordingId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      audioDoneWaiters.delete(recordingId);
      resolve();
    };
    audioDoneWaiters.set(recordingId, done);
    setTimeout(() => {
      if (audioDoneWaiters.has(recordingId)) {
        console.warn("[scout] audio_done timeout for", recordingId);
        done();
      }
    }, timeoutMs);
  });
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
  // refuse — we degrade gracefully. Chrome also rate-limits captureVisibleTab
  // to a couple of calls per second, so we skip routine character keystrokes
  // and enforce a minimum gap between captures.
  const tabId = sender.tab?.id ?? null;
  if (tabId != null && shouldCaptureForEvent(ev) && canCaptureNow()) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT, {
        format: "jpeg",
        quality: 70,
      });
      lastCaptureAt = Date.now();
      const screenshotId = uuid();
      ev._screenshotDataUrl = dataUrl;
      ev.screenshot_path = `${state.user_id}/${state.recording_id}/${screenshotId}.jpg`;
      await putScreenshot(screenshotId, dataUrl);
    } catch (err) {
      ev.screenshot_path = null;
      // Log once-per-distinct-reason rather than per-event so a non-capturable
      // page doesn't flood the events table.
      const reason = String((err as Error)?.message || err);
      if (lastFailureReason !== reason) {
        lastFailureReason = reason;
        const failEv: CapturedEvent = {
          recording_id: state.recording_id,
          user_id: state.user_id,
          ts_ms: ev.ts_ms,
          kind: "screenshot_failed",
          data: { reason, original_kind: ev.kind },
          _localId: uuid(),
        };
        buffer.push(failEv);
        await bumpCounters(failEv);
      }
    }
  }

  buffer.push(ev);
  await bumpCounters(ev);
}

// Chrome rate-limits captureVisibleTab to ~2/sec (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND).
// 500ms is the floor; going lower returns "MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota".
const SCREENSHOT_MIN_GAP_MS = 500;
let lastCaptureAt = 0;
let lastFailureReason: string | null = null;

function canCaptureNow(): boolean {
  return Date.now() - lastCaptureAt >= SCREENSHOT_MIN_GAP_MS;
}

// Capture the visible area of a specific tab and append an event with the
// screenshot attached. Used for non-content-driven moments — recording start,
// tab switches, and navigations — that wouldn't otherwise carry visual context.
async function captureTabAndQueue(
  tabId: number,
  windowId: number | null,
  kind: CapturedEvent["kind"],
  data: Record<string, unknown>,
): Promise<void> {
  const state = await loadSession();
  if (!state || state.is_paused) return;

  const ev: CapturedEvent = {
    recording_id: state.recording_id,
    user_id: state.user_id,
    ts_ms: Date.now() - state.started_at - state.paused_ms,
    kind,
    data,
    _localId: uuid(),
  };

  if (canCaptureNow()) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(
        windowId ?? chrome.windows.WINDOW_ID_CURRENT,
        { format: "jpeg", quality: 70 },
      );
      lastCaptureAt = Date.now();
      const screenshotId = uuid();
      ev._screenshotDataUrl = dataUrl;
      ev.screenshot_path = `${state.user_id}/${state.recording_id}/${screenshotId}.jpg`;
      await putScreenshot(screenshotId, dataUrl);
    } catch (err) {
      ev.screenshot_path = null;
      const reason = String((err as Error)?.message || err);
      if (lastFailureReason !== reason) {
        lastFailureReason = reason;
        console.warn("[scout] captureVisibleTab failed", { tabId, reason });
      }
    }
  }

  buffer.push(ev);
  await bumpCounters(ev);
}

// Maintain live counters in session state so the popup can show an accurate
// "N events / M screenshots" tally without polling Postgres. Persisting is
// cheap (chrome.storage.session is in-memory) and tolerable per event.
async function bumpCounters(ev: CapturedEvent): Promise<void> {
  const s = await loadSession();
  if (!s) return;
  s.event_count = (s.event_count ?? 0) + 1;
  if (ev.screenshot_path) s.shot_count = (s.shot_count ?? 0) + 1;
  await saveSession(s);
  chrome.runtime
    .sendMessage({
      type: "popup:counts",
      event_count: s.event_count,
      shot_count: s.shot_count,
    } satisfies RuntimeMessage)
    .catch(() => {});
}

const SIGNIFICANT_KEYS = new Set(["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

function shouldCaptureForEvent(ev: CapturedEvent): boolean {
  if (ev.kind === "scroll" || ev.kind === "tab_switch") return false;
  // For keydown, only capture on significant keys or when a modifier is held.
  // Plain character entry would otherwise cause a flood of capture attempts
  // (Chrome rate-limits captureVisibleTab to ~2 calls per second).
  if (ev.kind === "keydown") {
    const data = ev.data as { key?: string; modifiers?: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean } };
    const key = data.key ?? "";
    const m = data.modifiers ?? { alt: false, ctrl: false, meta: false, shift: false };
    if (m.ctrl || m.alt || m.meta) return true;
    return SIGNIFICANT_KEYS.has(key);
  }
  return true;
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
  console.log("[scout] onAudioDone fired, bytes=" + (bytes?.byteLength ?? 0), recordingId);
  if (!userId || !recordingId) {
    console.warn("[scout] audio_done without recording context");
    await closeOffscreen();
    return;
  }

  // No audio captured (mic denied, no device, or recorder never started).
  // Skip the upload and let transcribe short-circuit on a null audio_path.
  if (!bytes || bytes.byteLength === 0 || !mimeType) {
    console.log("[scout] audio_done with no bytes — going straight to transcribe", recordingId);
    await sb.from("recordings").update({ audio_path: null, status: "transcribing" }).eq("id", recordingId);
    broadcastRecordingChanged(recordingId, "transcribing");
    await closeOffscreen();
    try {
      await triggerTranscribe(recordingId);
      console.log("[scout] transcribe ok, broadcasting ready", recordingId);
      broadcastRecordingChanged(recordingId, "ready");
    } catch (e) {
      console.warn("[scout] transcribe failed (no-audio path)", e);
      broadcastRecordingChanged(recordingId, "failed");
    }
    audioDoneWaiters.get(recordingId)?.();
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
    broadcastRecordingChanged(recordingId, "failed");
    await closeOffscreen();
    audioDoneWaiters.get(recordingId)?.();
    return;
  }

  await sb.from("recordings").update({ audio_path: path, status: "transcribing" }).eq("id", recordingId);
  broadcastRecordingChanged(recordingId, "transcribing");
  await closeOffscreen();

  try {
    await triggerTranscribe(recordingId);
    broadcastRecordingChanged(recordingId, "ready");
  } catch (e) {
    console.warn("[scout] transcribe failed", e);
    broadcastRecordingChanged(recordingId, "failed");
  }
  audioDoneWaiters.get(recordingId)?.();
}

async function triggerTranscribe(recordingId: string): Promise<void> {
  const sb = getSupabase();
  const { data: sess } = await sb.auth.getSession();
  if (!sess.session) throw new Error("not authenticated");
  const res = await fetch(functionUrl("transcribe"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sess.session.access_token}` },
    body: JSON.stringify({ recording_id: recordingId }),
  });
  if (!res.ok) throw new Error(`transcribe ${res.status}: ${await res.text()}`);
}

// ---- Tab lifecycle (cross-tab capture) ----

chrome.tabs.onActivated.addListener(async (info) => {
  const state = await loadSession();
  if (!state || state.is_paused) return;
  const tab = await chrome.tabs.get(info.tabId).catch(() => null);
  await captureTabAndQueue(info.tabId, tab?.windowId ?? null, "tab_switch", {
    to_tab_id: info.tabId,
    to_tab_url: tab?.url ?? null,
  });
  // Make sure the new tab has the control bar.
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "content:show_control_bar" } satisfies RuntimeMessage).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await loadSession();
  if (!state) return;
  const ev: CapturedEvent = {
    recording_id: state.recording_id,
    user_id: state.user_id,
    ts_ms: Date.now() - state.started_at - state.paused_ms,
    kind: "tab_closed",
    data: { tab_id: tabId },
    _localId: uuid(),
  };
  buffer.push(ev);
  await bumpCounters(ev);
});

// Wait for the page to actually paint before capturing — onCommitted fires
// before the DOM is ready, so a screenshot at that instant captures the
// previous page or a blank frame.
chrome.webNavigation?.onCompleted?.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const state = await loadSession();
  if (!state || state.is_paused) return;
  const tab = await chrome.tabs.get(details.tabId).catch(() => null);
  await captureTabAndQueue(details.tabId, tab?.windowId ?? null, "navigation", {
    to_url: details.url,
  });
});

// ---- Message router ----

async function broadcastToTabs(msg: RuntimeMessage): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((t) => (t.id ? chrome.tabs.sendMessage(t.id, msg).catch(() => {}) : Promise.resolve()))
  );
}

// Broadcast a recording status change to anything listening (popup, library
// tab cards). Best-effort — popup may be closed.
function broadcastRecordingChanged(recordingId: string, status: RecordingRow["status"]): void {
  chrome.runtime.sendMessage({
    type: "popup:recording_changed",
    recording_id: recordingId,
    status,
  } satisfies RuntimeMessage).catch(() => {});
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
            // Tell the popup so it can show "audio: off" in the recording UI.
            chrome.runtime.sendMessage({ type: "popup:state", state: s } satisfies RuntimeMessage).catch(() => {});
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
