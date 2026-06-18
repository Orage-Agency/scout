import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { uIOhook } from "uiohook-napi";
import type { CaptureSession, OsEvent, OsEventData, OsEventKind } from "../shared/types";
import { captureAnchor } from "./anchors";
import { startScreenRecording, stopScreenRecording } from "./screen-recorder";
import { getSettings } from "./settings";
import { logLine } from "./logger";

type Listener = (e: OsEvent) => void;

const FLUSH_INTERVAL_MS = 1000;

let session: CaptureSession | null = null;
let buffer: OsEvent[] = [];
let listeners: Listener[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let hooksBound = false;

export function isCapturing(): boolean {
  return session !== null;
}

export function getActiveSession(): CaptureSession | null {
  return session;
}

export function onEvent(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

export function recordingDir(id: string): string {
  return path.join(app.getPath("userData"), "recordings", id);
}

function makeEvent(kind: OsEventKind, data: OsEventData): OsEvent | null {
  if (!session) return null;
  return {
    id: randomUUID(),
    recording_id: session.recording_id,
    ts_ms: Date.now() - session.started_at_ms,
    kind,
    data,
  };
}

function pushEvent(ev: OsEvent): void {
  if (!session) return;
  buffer.push(ev);
  session.event_count += 1;
  for (const l of listeners) l(ev);
}

function emit(kind: OsEventKind, data: OsEventData): void {
  const ev = makeEvent(kind, data);
  if (ev) pushEvent(ev);
}

function bindHooks(): void {
  if (hooksBound) return;
  hooksBound = true;

  uIOhook.on("mousedown", (e) => {
    const ev = makeEvent("os_mousedown", { x: e.x, y: e.y, button: e.button });
    if (!ev) return;
    if (session && getSettings().capture_anchors !== false) {
      const recId = session.recording_id;
      const evId = ev.id;
      const x = e.x;
      const y = e.y;
      ev.data.anchor_path = path.posix.join("anchors", `${evId}.png`);
      // Fire-and-forget anchor capture. Slight delay vs event timestamp is acceptable;
      // the file just needs to exist before sync/replay reads it.
      void captureAnchor(recordingDir(recId), evId, x, y);
    }
    pushEvent(ev);
  });
  uIOhook.on("mouseup", (e) => {
    emit("os_mouseup", { x: e.x, y: e.y, button: e.button });
  });
  uIOhook.on("click", (e) => {
    emit("os_click", { x: e.x, y: e.y, button: e.button, clicks: e.clicks });
  });
  uIOhook.on("keydown", (e) => {
    emit("os_keydown", {
      keycode: e.keycode,
      keychar: e.keychar,
      rawcode: e.rawcode,
      modifiers: {
        alt: e.altKey,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        shift: e.shiftKey,
      },
    });
  });
  uIOhook.on("keyup", (e) => {
    emit("os_keyup", {
      keycode: e.keycode,
      keychar: e.keychar,
      rawcode: e.rawcode,
      modifiers: {
        alt: e.altKey,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        shift: e.shiftKey,
      },
    });
  });
  uIOhook.on("wheel", (e) => {
    emit("os_wheel", {
      x: e.x,
      y: e.y,
      rotation: e.rotation,
      direction: e.direction,
    });
  });
}

async function flushToDisk(force = false): Promise<void> {
  if (!session) return;
  if (buffer.length === 0 && !force) return;
  const dir = recordingDir(session.recording_id);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "events.ndjson");
  const chunk = buffer.splice(0, buffer.length);
  if (chunk.length === 0) return;
  const lines = chunk.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fs.appendFile(file, lines);
}

export async function startCapture(): Promise<CaptureSession> {
  if (session) return session;
  session = {
    recording_id: randomUUID(),
    started_at_ms: Date.now(),
    event_count: 0,
  };
  bindHooks();
  uIOhook.start();
  flushTimer = setInterval(() => {
    flushToDisk().catch(() => {
      // swallow — next interval retries
    });
  }, FLUSH_INTERVAL_MS);
  const dir = recordingDir(session.recording_id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "session.json"),
    JSON.stringify(session, null, 2)
  );

  if (getSettings().record_screen !== false) {
    void startScreenRecording(session.recording_id).catch((err) => {
      void logLine(`[capture] screen-record start failed: ${String(err)}`);
    });
  }

  return session;
}

export async function appendWebEvent(payload: {
  url: string;
  title?: string;
  selector?: string;
  kind: string;
  meta?: Record<string, unknown>;
}): Promise<boolean> {
  const ev = makeEvent("web_event", {
    web_kind: payload.kind,
    url: payload.url,
    title: payload.title,
    selector: payload.selector,
    meta: payload.meta,
  });
  if (!ev) return false;
  pushEvent(ev);
  return true;
}

export async function stopCapture(): Promise<CaptureSession | null> {
  if (!session) return null;
  try {
    uIOhook.stop();
  } catch {
    // already stopped — ignore
  }
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  // Stop screen recording before final flush so video is sealed.
  try {
    await stopScreenRecording();
  } catch (err) {
    await logLine(`[capture] screen-record stop failed: ${String(err)}`);
  }

  session.ended_at_ms = Date.now();
  await flushToDisk(true);
  const dir = recordingDir(session.recording_id);
  await fs.writeFile(
    path.join(dir, "session.json"),
    JSON.stringify(session, null, 2)
  );
  const done = session;
  session = null;
  return done;
}
