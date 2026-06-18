import { Button, Key, Point, keyboard, mouse } from "@nut-tree-fork/nut-js";
import { mapKeycode, RELEASE_ON_ABORT } from "./keymap";
import { findAnchorCenter } from "./anchors";
import { logLine } from "./logger";
import type { OsEvent, ReplayOptions, ReplayProgress } from "../shared/types";

mouse.config.mouseSpeed = 2000;
mouse.config.autoDelayMs = 0;
keyboard.config.autoDelayMs = 0;

type ProgressListener = (p: ReplayProgress) => void;

let progress: ReplayProgress = {
  recording_id: null,
  total: 0,
  current: 0,
  phase: "idle",
};
let abortRequested = false;
let listeners: ProgressListener[] = [];

export function isReplaying(): boolean {
  return progress.phase === "running" || progress.phase === "countdown";
}

export function getReplayProgress(): ReplayProgress {
  return { ...progress };
}

export function onReplayProgress(fn: ProgressListener): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

function setProgress(patch: Partial<ReplayProgress>): void {
  progress = { ...progress, ...patch };
  const snapshot = { ...progress };
  for (const l of listeners) l(snapshot);
}

export function requestAbort(): void {
  if (isReplaying()) {
    abortRequested = true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function buttonFromUiohook(b: number | undefined): Button {
  switch (b) {
    case 2:
      return Button.RIGHT;
    case 3:
      return Button.MIDDLE;
    default:
      return Button.LEFT;
  }
}

interface DispatchContext {
  recordingDir: string;
  useAnchors: boolean;
  anchorHits: number;
  anchorMisses: number;
}

async function dispatchEvent(ev: OsEvent, ctx: DispatchContext): Promise<void> {
  switch (ev.kind) {
    case "os_mousedown": {
      let x = ev.data.x;
      let y = ev.data.y;
      if (ctx.useAnchors && ev.data.anchor_path) {
        const found = await findAnchorCenter(ctx.recordingDir, ev.data.anchor_path);
        if (found) {
          x = found.x;
          y = found.y;
          ctx.anchorHits += 1;
        } else {
          ctx.anchorMisses += 1;
          await logLine(
            `[replay] anchor-miss eventId=${ev.id} — falling back to coord (${x},${y})`
          );
        }
      }
      if (x !== undefined && y !== undefined) {
        await mouse.setPosition(new Point(x, y));
      }
      await mouse.pressButton(buttonFromUiohook(ev.data.button));
      return;
    }
    case "os_mouseup": {
      await mouse.releaseButton(buttonFromUiohook(ev.data.button));
      return;
    }
    case "os_click": {
      // mousedown + mouseup pair already covers this.
      return;
    }
    case "os_keydown": {
      const k = mapKeycode(ev.data.keycode);
      if (k !== null) await keyboard.pressKey(k);
      return;
    }
    case "os_keyup": {
      const k = mapKeycode(ev.data.keycode);
      if (k !== null) await keyboard.releaseKey(k);
      return;
    }
    case "os_wheel": {
      // Wheel replay disabled — apps interpret scroll deltas inconsistently.
      return;
    }
  }
}

async function safeRelease(): Promise<void> {
  for (const btn of [Button.LEFT, Button.RIGHT, Button.MIDDLE]) {
    try {
      await mouse.releaseButton(btn);
    } catch {
      // ignore
    }
  }
  for (const k of RELEASE_ON_ABORT) {
    try {
      await keyboard.releaseKey(k);
    } catch {
      // ignore
    }
  }
}

export async function runEvents(
  events: OsEvent[],
  recordingId: string,
  recordingDir: string,
  opts: ReplayOptions = {}
): Promise<void> {
  if (isReplaying()) throw new Error("Replay already running");
  if (events.length === 0) {
    setProgress({ recording_id: recordingId, total: 0, current: 0, phase: "done" });
    return;
  }

  abortRequested = false;
  const speed = opts.speed ?? 1.0;
  const startDelayMs = opts.startDelayMs ?? 3000;
  const t0 = opts.pruneInitialIdle === false ? 0 : events[0].ts_ms;
  const ctx: DispatchContext = {
    recordingDir,
    useAnchors: opts.useAnchors !== false,
    anchorHits: 0,
    anchorMisses: 0,
  };

  setProgress({
    recording_id: recordingId,
    total: events.length,
    current: 0,
    phase: "countdown",
    message: `Starting in ${Math.ceil(startDelayMs / 1000)}s`,
  });
  await logLine(
    `[replay] start recording=${recordingId} events=${events.length} speed=${speed} anchors=${ctx.useAnchors}`
  );

  const tick = 1000;
  let remaining = startDelayMs;
  while (remaining > 0) {
    if (abortRequested) {
      setProgress({ phase: "aborted", message: "Aborted before start" });
      await logLine(`[replay] aborted during countdown recording=${recordingId}`);
      return;
    }
    setProgress({ message: `Starting in ${Math.ceil(remaining / 1000)}s` });
    await sleep(Math.min(tick, remaining));
    remaining -= tick;
  }

  setProgress({ phase: "running", message: undefined });
  const realStart = Date.now();

  try {
    for (let i = 0; i < events.length; i++) {
      if (abortRequested) break;
      const ev = events[i];
      const targetReal = (ev.ts_ms - t0) / speed;
      const elapsed = Date.now() - realStart;
      const wait = targetReal - elapsed;
      if (wait > 0) await sleep(wait);
      if (abortRequested) break;

      await dispatchEvent(ev, ctx);
      if ((i + 1) % 10 === 0 || i === events.length - 1) {
        setProgress({ current: i + 1 });
      }
    }
    await safeRelease();
    setProgress({
      current: abortRequested ? progress.current : events.length,
      phase: abortRequested ? "aborted" : "done",
    });
    await logLine(
      `[replay] ${abortRequested ? "aborted" : "done"} recording=${recordingId} ` +
        `${progress.current}/${events.length} anchorHits=${ctx.anchorHits} anchorMisses=${ctx.anchorMisses}`
    );
  } catch (err) {
    await safeRelease();
    setProgress({ phase: "error", message: String(err) });
    await logLine(`[replay] error recording=${recordingId} err=${String(err)}`);
    throw err;
  }
}
