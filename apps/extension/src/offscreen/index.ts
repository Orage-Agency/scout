// Offscreen document — service workers can't access MediaRecorder, so we
// host audio capture here. Lifecycle is owned by the service worker.

import type { RuntimeMessage } from "../lib/types";

// mainRecorder runs the full session and feeds offscreen:audio_done at stop.
// liveRecorder cycles every 5 s; each new instance starts fresh with an EBML
// header, so each chunk is independently decodable. Both record from the same
// stream simultaneously.
let mainRecorder: MediaRecorder | null = null;
let liveRecorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let mainChunks: BlobPart[] = [];
let liveChunks: BlobPart[] = [];
let chosenMime = "audio/webm;codecs=opus";
let chunkTimer: ReturnType<typeof setInterval> | null = null;
let isFinalStop = false;

// Build a MediaRecorder whose ondataavailable always pushes into the given
// buf array. The closure captures buf at creation time, so reassigning the
// module-level variable later doesn't redirect data into the wrong array.
function makeRecorder(s: MediaStream, buf: BlobPart[]): MediaRecorder {
  const r = new MediaRecorder(s, { mimeType: chosenMime, audioBitsPerSecond: 96_000 });
  r.ondataavailable = (e) => { if (e.data && e.data.size > 0) buf.push(e.data); };
  return r;
}

// Stop the current liveRecorder, send its audio as offscreen:audio_chunk, then
// start a fresh one so the next chunk begins with its own EBML header.
async function cycleChunk(): Promise<void> {
  if (isFinalStop || !liveRecorder || !stream) return;

  const prevRecorder = liveRecorder;
  const prevChunks = liveChunks;

  // Swap to new recorder before stopping old so no audio is dropped.
  liveChunks = [];
  const nextRecorder = makeRecorder(stream, liveChunks);
  liveRecorder = nextRecorder;

  await new Promise<void>((resolve) => {
    prevRecorder.onstop = () => resolve();
    if (prevRecorder.state !== "inactive") prevRecorder.stop();
    else resolve();
  });

  if (isFinalStop) return;
  nextRecorder.start(1000);

  if (prevChunks.length === 0) return;
  const blob = new Blob(prevChunks, { type: chosenMime });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength === 0) return;
  chrome.runtime.sendMessage({
    type: "offscreen:audio_chunk",
    chunkB64: uint8ToBase64(bytes),
    mimeType: chosenMime,
  } satisfies RuntimeMessage).catch(() => {});
}

async function start(): Promise<void> {
  if (mainRecorder) return;
  isFinalStop = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    chrome.runtime.sendMessage({
      type: "offscreen:audio_error",
      error: String((err as Error)?.message || err),
    } satisfies RuntimeMessage);
    return;
  }

  const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  chosenMime = preferred.find((m) => MediaRecorder.isTypeSupported(m)) ?? "audio/webm";
  mainChunks = [];
  liveChunks = [];

  mainRecorder = makeRecorder(stream, mainChunks);
  mainRecorder.onerror = (e) => {
    chrome.runtime.sendMessage({
      type: "offscreen:audio_error",
      error: String((e as { error?: { message?: string } }).error?.message ?? "MediaRecorder error"),
    } satisfies RuntimeMessage);
  };
  mainRecorder.start(1000);

  liveRecorder = makeRecorder(stream, liveChunks);
  liveRecorder.start(1000);

  chunkTimer = setInterval(() => void cycleChunk(), 5000);
}

async function stop(): Promise<void> {
  isFinalStop = true;
  if (chunkTimer != null) {
    clearInterval(chunkTimer);
    chunkTimer = null;
  }

  if (!mainRecorder) {
    chrome.runtime.sendMessage({
      type: "offscreen:audio_done",
      bytesB64: "",
      byteLength: 0,
      mimeType: "",
    } satisfies RuntimeMessage);
    return;
  }

  // Stop the live recorder; we don't need its partial chunk for the final audio.
  const lr = liveRecorder;
  liveRecorder = null;
  if (lr && lr.state !== "inactive") lr.stop();

  // Release the mic so Chrome's recording indicator clears immediately.
  stream?.getTracks().forEach((t) => t.stop());

  await new Promise<void>((resolve) => {
    mainRecorder!.onstop = () => resolve();
    if (mainRecorder!.state !== "inactive") mainRecorder!.stop();
    else resolve();
  });

  const blob = new Blob(mainChunks, { type: chosenMime });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const bytesB64 = uint8ToBase64(bytes);
  chrome.runtime.sendMessage({
    type: "offscreen:audio_done",
    bytesB64,
    byteLength: bytes.byteLength,
    mimeType: chosenMime,
  } satisfies RuntimeMessage);

  mainRecorder = null;
  stream = null;
  mainChunks = [];
  liveChunks = [];
}

function uint8ToBase64(buf: Uint8Array): string {
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)));
  }
  return btoa(s);
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
