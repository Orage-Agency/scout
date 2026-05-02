// Offscreen document — service workers can't access MediaRecorder, so we
// host audio capture here. Lifecycle is owned by the service worker.

import type { RuntimeMessage } from "../lib/types";

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: BlobPart[] = [];
let chosenMime = "audio/webm;codecs=opus";

async function start(): Promise<void> {
  if (recorder) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    chrome.runtime.sendMessage({
      type: "offscreen:audio_error",
      error: String((err as Error)?.message || err),
    } satisfies RuntimeMessage);
    return;
  }

  // Pick the best supported codec.
  const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  chosenMime = preferred.find((m) => MediaRecorder.isTypeSupported(m)) ?? "audio/webm";
  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: chosenMime, audioBitsPerSecond: 96_000 });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onerror = (e) => {
    chrome.runtime.sendMessage({
      type: "offscreen:audio_error",
      error: String((e as { error?: { message?: string } }).error?.message ?? "MediaRecorder error"),
    } satisfies RuntimeMessage);
  };
  recorder.start(1000); // emit a chunk every 1s so we don't lose much on crash
}

async function stop(): Promise<void> {
  if (!recorder) return;
  await new Promise<void>((resolve) => {
    recorder!.onstop = () => resolve();
    recorder!.stop();
  });
  stream?.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: chosenMime });
  const bytes = await blob.arrayBuffer();
  chrome.runtime.sendMessage({
    type: "offscreen:audio_done",
    bytes,
    mimeType: chosenMime,
  } satisfies RuntimeMessage);
  recorder = null;
  stream = null;
  chunks = [];
}

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg.type === "offscreen:start_audio") {
    start().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "offscreen:stop_audio") {
    stop().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
