// Service worker — owns the global recording session.
// MV3 service workers can shut down on inactivity; we persist state in
// chrome.storage.session so the worker can rehydrate transparently.

import { getAuthSupabase, getDataSupabase, functionUrl } from "../lib/supabase";
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

// Coach ring buffer — keeps the last N events even AFTER flushBuffer clears
// the main buffer. Without this, the 30s coach cycle reads `buffer.slice(-15)`
// just after a 5s flush has emptied it, sees zero events, and silently
// returns — which is why the coach was effectively never firing.
const COACH_RING_MAX = 40;
let coachRing: CapturedEvent[] = [];
function pushCoachRing(ev: CapturedEvent): void {
  coachRing.push(ev);
  if (coachRing.length > COACH_RING_MAX) coachRing.splice(0, coachRing.length - COACH_RING_MAX);
}
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

async function startRecording(
  micEnabled: boolean,
  mode: "skill" | "improvement" = "skill",
  tier: "quick" | "standard" | "deep" = "standard",
): Promise<RecordingSessionState | null> {
  const authClient = getAuthSupabase();
  const db = getDataSupabase();
  const { data: auth } = await authClient.auth.getUser();
  if (!auth.user) {
    console.warn("[scout] start_recording: not authenticated");
    return null;
  }

  // Create the recording row first so we have a stable id for storage paths.
  const recordingId = uuid();
  const startedAtMs = Date.now();
  const { error } = await db
    .from("recordings")
    .insert({
      id: recordingId,
      user_id: auth.user.id,
      status: "recording",
      mode,
      started_at: new Date(startedAtMs).toISOString(),
      // tier lives in meta so we don't need a schema migration for an
      // experimental knob. generate-skill reads rec.meta.tier.
      meta: { ua: navigator.userAgent, platform: navigator.platform, tier },
    });
  if (error) {
    console.error("[scout] failed to insert recording", error);
    // We still let the user record — events queue locally and flush later.
  } else {
    broadcastRecordingChanged(recordingId, "recording");
  }

  const [activeAtStart] = await chrome.tabs.query({ active: true, currentWindow: true });
  const state: RecordingSessionState = {
    recording_id: recordingId,
    user_id: auth.user.id,
    started_at: startedAtMs,
    paused_ms: 0,
    is_paused: false,
    // audio_supported = browser/OS capability (flipped to false on
    // offscreen:audio_error if getUserMedia is denied). mic_enabled =
    // user intent (the Voice narration toggle). Two distinct states so
    // the popup can show "off" vs "denied" correctly.
    audio_supported: true,
    mic_enabled: micEnabled,
    mode,
    ask_count: 0,
    last_ask_at: 0,
    event_count: 0,
    shot_count: 0,
    active_tab_title: activeAtStart?.title ?? null,
    active_tab_url: activeAtStart?.url ?? null,
  };
  await saveSession(state);

  if (micEnabled) {
    await ensureOffscreen();
    await sendToOffscreen({ type: "offscreen:start_audio" });
  }

  await broadcastToTabs({ type: "content:show_control_bar" });
  chrome.action.setBadgeText({ text: "REC" });
  chrome.action.setBadgeBackgroundColor({ color: "#DC2626" });

  // Reset per-recording capture state so failures and rate limits don't carry
  // across sessions.
  lastCaptureAt = 0;
  lastFailureReason = null;
  coachRing = [];

  startTimers();

  // Inject the content script into pre-existing tabs — Chrome only auto-injects
  // on page load, so tabs that were already open when recording started won't
  // capture clicks/keys/etc. without explicit injection. Per brief §11.2.1.
  await injectContentIntoOpenTabs();

  // Capture the initial state of the active tab so even a session with zero
  // user input still yields a visual anchor for the LLM.
  if (activeAtStart?.id != null) {
    await captureTabAndQueue(activeAtStart.id, activeAtStart.windowId ?? null, "navigation", {
      to_url: activeAtStart.url ?? null,
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
  chrome.action.setBadgeText({ text: "" });
  await flushBuffer();

  // Serialize the audio finalize so onAudioDone runs to completion BEFORE we
  // clear the session and exit. Otherwise the parallel 'uploading' update
  // here can overwrite the 'transcribing' update from onAudioDone.
  const db = getDataSupabase();
  const endedAt = Date.now();
  const durationMs = endedAt - state.started_at - state.paused_ms;

  // 1a. Voice narration disabled — no audio to upload or transcribe. Go
  //     straight to ready with an empty transcript so the skill generator
  //     can run immediately from events + screenshots alone.
  if (state.mic_enabled === false) {
    await db
      .from("recordings")
      .update({
        status: "ready",
        ended_at: new Date(endedAt).toISOString(),
        duration_ms: durationMs,
        transcript: { segments: [] },
      })
      .eq("id", state.recording_id);
    broadcastRecordingChanged(state.recording_id, "ready");
    // Defensive: in case an offscreen document was opened by a race
    // (e.g. the user toggled mic mid-recording in a future build), make
    // sure it's closed so the mic + the offscreen page don't leak.
    await closeOffscreen();
    await saveSession(null);
    await chrome.runtime.sendMessage({ type: "popup:state", state: null }).catch(() => {});
    console.log("[scout] recording stopped (no audio)", state.recording_id);
    return;
  }

  // 1b. Mark the row as ended + uploading. Single atomic update; no further
  //     writes happen here.
  await db
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
  broadcastPauseState(true, state.event_count);
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
  broadcastPauseState(false, state.event_count);
}

// MV3 service workers hibernate after ~30s of idle, which silently kills
// setInterval. chrome.alarms is the only timer that wakes the worker back
// up. We use an alarm for the flush + coach cadences AND keep the existing
// setInterval as a fast-path for the case where the worker is already
// alive (alarms are clamped to a 30s minimum in production builds, while
// our flush wants 5s when active). The setInterval still runs while the
// worker is alive; the alarm is the safety net during long quiet stretches.

const ALARM_FLUSH = "scout-flush";
const ALARM_COACH = "scout-coach";
// chrome.alarms minimum period in production builds is 30s. We accept the
// trade: during a hibernate-and-wake cycle, the next flush could be up to
// 30s late instead of 5s late. Mid-recording, when the user is interacting,
// the setInterval below fires every 5s as expected.
const ALARM_FLUSH_MIN = 0.5; // 30s in minutes
const ALARM_COACH_MIN = 0.5; // 30s, same as the existing coach cadence

function startTimers(): void {
  stopTimers();
  flushTimer = setInterval(() => void flushBuffer(), FLUSH_INTERVAL_MS) as unknown as number;
  coachTimer = setInterval(() => void runCoachCycle(), COACH_INTERVAL_MS) as unknown as number;
  // Schedule alarms so a hibernated worker is woken up to flush.
  chrome.alarms.create(ALARM_FLUSH, { periodInMinutes: ALARM_FLUSH_MIN });
  chrome.alarms.create(ALARM_COACH, { periodInMinutes: ALARM_COACH_MIN });
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
  chrome.alarms.clear(ALARM_FLUSH).catch(() => {});
  chrome.alarms.clear(ALARM_COACH).catch(() => {});
}

// Alarm handler: woken up after hibernation, run the catch-up flush + coach.
// Top-level listener registration (not gated on a recording) so the worker
// rebinds it on cold start and responds to alarms even after a kill.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_FLUSH) void flushBuffer();
  else if (alarm.name === ALARM_COACH) void runCoachCycle();
});

// ---- Event ingestion ----

// Auto-title: on the first navigation event, save the page title so the
// library shows a real name immediately (before skill generation backfills it).
const autoTitledRecordings = new Set<string>();

async function maybeAutoTitle(state: RecordingSessionState, ev: CapturedEvent): Promise<void> {
  if (ev.kind !== "navigation") return;
  if (autoTitledRecordings.has(state.recording_id)) return;
  autoTitledRecordings.add(state.recording_id);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const rawTitle = (tab?.title ?? "").trim();
    if (!rawTitle || rawTitle === "New Tab") return;
    // Shorten to 80 chars, strip " - Chrome" / " | Company" suffixes
    const title = rawTitle.replace(/\s*[-|]\s*(?:Google Chrome|Mozilla Firefox|Safari|Edge)$/i, "").trim().slice(0, 80);
    if (title) {
      const db = getDataSupabase();
      await db.from("recordings").update({ title }).eq("id", state.recording_id);
    }
  } catch { /* non-fatal */ }
}

async function onContentEvent(ev: CapturedEvent, sender: chrome.runtime.MessageSender): Promise<void> {
  const state = await loadSession();
  if (!state || state.is_paused) return;

  ev.recording_id = state.recording_id;
  ev.user_id = state.user_id;
  ev.ts_ms = Date.now() - state.started_at - state.paused_ms;

  // Auto-title from first navigation
  void maybeAutoTitle(state, ev);

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
        pushCoachRing(failEv);
        await bumpCounters(failEv);
      }
    }
  }

  buffer.push(ev);
  pushCoachRing(ev);
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
  pushCoachRing(ev);
  await bumpCounters(ev);
}

// Returns a human-readable description for the live capture feed.
// Returns null for noisy events (scroll, focus_change, etc.) that
// clutter the feed without adding signal.
function describeEvent(ev: CapturedEvent): string | null {
  const d = ev.data ?? {};
  switch (ev.kind) {
    case "click": {
      const t = d.target as { visibleText?: string; selector?: string } | undefined;
      const ctx = String(d.context_text ?? "").slice(0, 30);
      const label = t?.visibleText || t?.selector || "element";
      return ctx ? `Clicked: ${label} — ${ctx}` : `Clicked: ${label}`;
    }
    case "paste": {
      const snippet = String(d.content_snippet ?? "").trim().slice(0, 40);
      return snippet ? `Pasted: "${snippet}"` : "Pasted into form";
    }
    case "copy": {
      const snippet = String(d.content_snippet ?? "").trim().slice(0, 40);
      return snippet ? `Copied: "${snippet}"` : "Copied text";
    }
    case "navigation": {
      try { return `Navigated to ${new URL(String(d.to_url ?? "")).hostname}`; } catch { return "Navigation"; }
    }
    case "tab_switch": {
      try { return `Tab: ${new URL(String(d.to_tab_url ?? "")).hostname}`; } catch { return "Switched tab"; }
    }
    case "select_change": return `Selected: ${String(d.selected_text ?? "").slice(0, 30)}`;
    case "checkbox_change": return `${d.checked ? "Checked" : "Unchecked"}: ${String(d.value ?? "").slice(0, 30)}`;
    case "form_fill": {
      const f = d.field as { visibleText?: string; selector?: string } | undefined;
      const val = String(d.value ?? "").trim().slice(0, 30);
      const fieldName = f?.visibleText || f?.selector || "field";
      return val ? `Filled ${fieldName}: "${val}"` : `Filled: ${fieldName}`;
    }
    case "coach_reply": return `Replied to coach`;
    // Noisy / low-signal — skip from live feed
    case "scroll":
    case "focus_change":
    case "keydown":
    case "screenshot_failed":
    case "tab_closed":
      return null;
    default: return null;
  }
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
      last_event_desc: describeEvent(ev) ?? undefined,
    } satisfies RuntimeMessage)
    .catch(() => {});
  // Push live count to the active tab's floating bar.
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: "content:update_count",
        event_count: s.event_count,
      } satisfies RuntimeMessage).catch(() => {});
    }
  });
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
  const db = getDataSupabase();

  // 1. Upload screenshots to Storage in parallel.
  await Promise.all(
    batch.map(async (ev) => {
      if (ev._screenshotDataUrl && ev.screenshot_path) {
        try {
          const blob = dataUrlToBlob(ev._screenshotDataUrl);
          const { error } = await db.storage
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
  const { error } = await db.from("events").insert(rows);
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

  // Read from coachRing — filter to events from the last 30s of recording time,
  // so the coach sees a consistent 30s window regardless of total recording length.
  const currentElapsed = Date.now() - state.started_at - state.paused_ms;
  const windowStart = currentElapsed - 30_000;
  const recentEvents = coachRing
    .filter((e) => e.ts_ms >= windowStart)
    .slice(-20)
    .map((e) => ({ kind: e.kind, ts_ms: e.ts_ms, data: e.data }));
  if (!recentEvents.length) {
    console.log("[scout] coach: no recent events, skipping");
    return;
  }
  console.log(`[scout] coach: calling /coach with ${recentEvents.length} events`);

  try {
    const authClient = getAuthSupabase();
    const db = getDataSupabase();
    const { data: sess } = await authClient.auth.getSession();
    if (!sess.session) return;

    const res = await fetch(functionUrl("coach"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sess.session.access_token}`,
      },
      body: JSON.stringify({
        events: recentEvents,
        transcript_tail: state.live_transcript_tail ?? "",
        ask_count: state.ask_count,
        current_url: state.active_tab_url ?? null,
        current_title: state.active_tab_title ?? null,
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
    await db.from("coach_log").insert({
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

async function onAudioDone(bytesB64: string, byteLength: number, mimeType: string): Promise<void> {
  const state = await loadSession();
  // The session might already be cleared (stop happened seconds ago) — still upload.
  const authClient = getAuthSupabase();
  const db = getDataSupabase();
  const { data: auth } = await authClient.auth.getUser();
  const userId = state?.user_id ?? auth.user?.id;
  // Look up the most recent uploading recording if no session.
  let recordingId = state?.recording_id;
  if (!recordingId && userId) {
    const { data } = await db
      .from("recordings")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "uploading")
      .order("started_at", { ascending: false })
      .limit(1);
    recordingId = data?.[0]?.id;
  }
  console.log("[scout] onAudioDone fired, bytes=" + byteLength, recordingId);
  if (!userId || !recordingId) {
    console.warn("[scout] audio_done without recording context");
    await closeOffscreen();
    return;
  }

  // Decode the base64 payload back to bytes for upload. Empty string + 0 length
  // means no audio (mic denied or recorder never produced data).
  const bytes = bytesB64 ? base64ToUint8(bytesB64) : null;

  // No audio captured (mic denied, no device, or recorder never started).
  // Skip the upload and let transcribe short-circuit on a null audio_path.
  if (!bytes || bytes.byteLength === 0 || !mimeType) {
    console.log("[scout] audio_done with no bytes — going straight to transcribe", recordingId);
    await db.from("recordings").update({ audio_path: null, status: "transcribing" }).eq("id", recordingId);
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
  const { error } = await db.storage
    .from("audio")
    .upload(path, new Blob([bytes as BlobPart], { type: mimeType }), { contentType: mimeType, upsert: true });
  if (error) {
    console.error("[scout] audio upload failed", error);
    await db.from("recordings").update({ status: "failed" }).eq("id", recordingId);
    broadcastRecordingChanged(recordingId, "failed");
    await closeOffscreen();
    audioDoneWaiters.get(recordingId)?.();
    return;
  }

  await db.from("recordings").update({ audio_path: path, status: "transcribing" }).eq("id", recordingId);
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

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function triggerTranscribe(recordingId: string): Promise<void> {
  const authClient = getAuthSupabase();
  const { data: sess } = await authClient.auth.getSession();
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
    to_tab_title: tab?.title ?? null,
  });
  // Update the popup's "current tab" indicator.
  state.active_tab_title = tab?.title ?? null;
  state.active_tab_url = tab?.url ?? null;
  await saveSession(state);
  chrome.runtime
    .sendMessage({ type: "popup:state", state } satisfies RuntimeMessage)
    .catch(() => {});
  // Make sure the new tab has the control bar.
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "content:show_control_bar" } satisfies RuntimeMessage).catch(() => {});
});

// Track tab title/url updates while it's the active tab, so the popup reflects
// SPA route changes inside Gmail / a CRM where the tab itself doesn't change.
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (!tab.active) return;
  if (!changeInfo.title && !changeInfo.url) return;
  const state = await loadSession();
  if (!state) return;
  state.active_tab_title = tab.title ?? state.active_tab_title;
  state.active_tab_url = tab.url ?? state.active_tab_url;
  await saveSession(state);
  chrome.runtime
    .sendMessage({ type: "popup:state", state } satisfies RuntimeMessage)
    .catch(() => {});
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
  pushCoachRing(ev);
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

// SPA navigation — SPAs (React Router, Next.js, Vue Router) update the URL
// via history.pushState without a full page load, so onCompleted never fires.
// onHistoryStateUpdated catches those transitions. Debounced to 500ms to skip
// rapid sequential pushState calls (e.g., scroll-driven URL updates).
let historyNavTimer: ReturnType<typeof setTimeout> | null = null;
let lastHistoryUrl: string | null = null;
chrome.webNavigation?.onHistoryStateUpdated?.addListener((details) => {
  if (details.frameId !== 0) return;
  if (details.url === lastHistoryUrl) return; // same URL — no meaningful nav
  lastHistoryUrl = details.url;
  if (historyNavTimer) clearTimeout(historyNavTimer);
  historyNavTimer = setTimeout(() => {
    historyNavTimer = null;
    void (async () => {
      const state = await loadSession();
      if (!state || state.is_paused) return;
      const tab = await chrome.tabs.get(details.tabId).catch(() => null);
      await captureTabAndQueue(details.tabId, tab?.windowId ?? null, "navigation", {
        to_url: details.url,
        spa: true,
      });
      state.active_tab_url = details.url;
      if (tab?.title) state.active_tab_title = tab.title;
      await saveSession(state);
      chrome.runtime.sendMessage({ type: "popup:state", state } satisfies RuntimeMessage).catch(() => {});
    })();
  }, 500);
});

// ---- Message router ----

// Programmatically inject the content script into every regular tab so
// recordings capture clicks/keys/paste even on pages that loaded before the
// user hit Record. Chrome's manifest content_scripts only auto-inject on
// page load, never retroactively. The content script self-guards against
// double-injection via a window flag.
async function injectContentIntoOpenTabs(): Promise<void> {
  // The bundled content script's filename has a Vite content hash that changes
  // every build, so we read the path from the runtime manifest instead of
  // hardcoding it.
  const manifest = chrome.runtime.getManifest();
  const files = manifest.content_scripts?.[0]?.js ?? [];
  if (!files.length) return;
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (t) => {
      if (!t.id || !t.url) return;
      // chrome.scripting refuses chrome://, chrome-extension://, edge://,
      // about:, view-source:, and the webstore — silently skip those.
      if (!/^(https?|file):/i.test(t.url)) return;
      if (/^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(t.url)) return;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: t.id },
          files,
        });
      } catch (err) {
        // Some pages refuse for reasons we can't predict (e.g., file:// without
        // user permission) — log once and move on, don't fail the whole start.
        console.warn("[scout] content script injection skipped", { tab: t.url, err: String(err) });
      }
    }),
  );
}

async function broadcastToTabs(msg: RuntimeMessage): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((t) => (t.id ? chrome.tabs.sendMessage(t.id, msg).catch(() => {}) : Promise.resolve()))
  );
}

// Push pause/resume state to the active tab's control bar so it stays in sync
// when the popup is used to pause/resume rather than the in-page bar buttons.
function broadcastPauseState(is_paused: boolean, event_count: number): void {
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: "content:update_count",
        event_count,
        is_paused,
      } satisfies RuntimeMessage).catch(() => {});
    }
  });
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
          // mic_enabled is required from the popup; if missing we default
          // to opt-out (false) — never silently capture audio.
          const state = await startRecording(
            msg.mic_enabled ?? false,
            msg.mode ?? "skill",
            msg.tier ?? "standard",
          );
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
          await onAudioDone(msg.bytesB64, msg.byteLength, msg.mimeType);
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
        case "offscreen:live_transcript": {
          const s = await loadSession();
          if (s) {
            const combined = ((s.live_transcript_tail ?? "") + " " + msg.text).trim();
            s.live_transcript_tail = combined.length > 200 ? combined.slice(-200) : combined;
            await saveSession(s);
            chrome.runtime
              .sendMessage({ type: "popup:transcript_tail", tail: s.live_transcript_tail } satisfies RuntimeMessage)
              .catch(() => {});
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

// ---- Keyboard shortcut (Alt+Shift+R) ----

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-recording") return;
  void (async () => {
    const state = await loadSession();
    if (state) {
      await stopRecording();
    } else {
      const { data } = await getAuthSupabase().auth.getSession();
      if (!data.session) return;
      const v = await chrome.storage.local.get(["scout:mic_enabled", "scout:recording_mode", "scout:tier"]);
      const mic = (v["scout:mic_enabled"] as boolean | undefined) ?? true;
      const rawMode = v["scout:recording_mode"] as string | undefined;
      const mode: "skill" | "improvement" = rawMode === "improvement" ? "improvement" : "skill";
      const rawTier = v["scout:tier"] as string | undefined;
      const tier: "quick" | "standard" | "deep" = rawTier === "quick" || rawTier === "deep" ? rawTier : "standard";
      await startRecording(mic, mode, tier);
    }
  })();
});

// On worker wake, restore badge state and restart timers if recording is active.
// If no session in storage (browser restarted), auto-fail any recordings this
// user left stuck in "recording" status — prevents the library showing a
// perpetual spinner on orphaned rows.
(async () => {
  const state = await loadSession();
  if (state && !state.is_paused) {
    startTimers();
    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#DC2626" });
  } else if (!state) {
    chrome.action.setBadgeText({ text: "" });
    void failStaleRecordings();
  }
})();

async function failStaleRecordings(): Promise<void> {
  try {
    const authClient = getAuthSupabase();
    const db = getDataSupabase();
    const { data: auth } = await authClient.auth.getUser();
    if (!auth.user) return;
    // Any recording stuck in "recording" status for > 5 minutes is orphaned.
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: stale } = await db
      .from("recordings")
      .select("id")
      .eq("user_id", auth.user.id)
      .eq("status", "recording")
      .lt("started_at", cutoff);
    if (!stale?.length) return;
    const ids = stale.map((r: { id: string }) => r.id);
    await db.from("recordings").update({ status: "failed" }).in("id", ids);
    for (const id of ids) broadcastRecordingChanged(id, "failed");
    console.log("[scout] auto-failed stale recordings", ids);
  } catch (err) {
    console.warn("[scout] failStaleRecordings error", err);
  }
}
