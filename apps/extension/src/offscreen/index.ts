// Offscreen document — service workers can't access MediaRecorder, so we
// host audio capture here. Lifecycle is owned by the service worker.

import type { RuntimeMessage } from "../lib/types";

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: BlobPart[] = [];
let chosenMime = "audio/webm;codecs=opus";

// Live speech-to-text via Web Speech API. Runs alongside MediaRecorder so the
// background coach gets a rolling transcript tail without waiting for Whisper.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recognition: any = null;

function startSpeechRecognition(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SpeechRec = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  if (!SpeechRec) return;
  try {
    recognition = new SpeechRec();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          const text = e.results[i][0].transcript.trim();
          if (text) {
            chrome.runtime.sendMessage({ type: "offscreen:live_transcript", text } satisfies RuntimeMessage).catch(() => {});
          }
        }
      }
    };
    recognition.onerror = () => { /* silent — mic denied, network error etc */ };
    recognition.onend = () => {
      // Auto-restart if still active (recognition stops on long silence).
      if (recognition) {
        try { recognition.start(); } catch { /* already stopped */ }
      }
    };
    recognition.start();
  } catch { /* SpeechRecognition not supported in this context */ }
}

function stopSpeechRecognition(): void {
  if (recognition) {
    recognition.onend = null; // disable auto-restart before stopping
    try { recognition.stop(); } catch { /* ignore */ }
    recognition = null;
  }
}

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
  startSpeechRecognition();
}

async function stop(): Promise<void> {
  if (!recorder) {
    // No mic / permission denied / start() failed. Still notify the service
    // worker so the recording can be finalized — otherwise it gets stuck at
    // status='uploading' forever waiting for audio that will never arrive.
    chrome.runtime.sendMessage({
      type: "offscreen:audio_done",
      bytesB64: "",
      byteLength: 0,
      mimeType: "",
    } satisfies RuntimeMessage);
    return;
  }
  stopSpeechRecognition();
  // Release the mic FIRST so Chrome's recording indicator clears immediately
  // and no further audio is captured. Stopping the tracks while the recorder
  // is still active causes the recorder to fire its final 'dataavailable'
  // event with the buffered audio, then 'stop' — same as calling
  // recorder.stop() explicitly, but the user-visible "mic on" state ends now
  // instead of after the recorder finalizes.
  stream?.getTracks().forEach((t) => t.stop());
  await new Promise<void>((resolve) => {
    recorder!.onstop = () => resolve();
    if (recorder!.state !== "inactive") recorder!.stop();
  });
  const blob = new Blob(chunks, { type: chosenMime });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // chrome.runtime.sendMessage between offscreen and the service worker
  // strips ArrayBuffer to {} in some Chrome builds. Base64 the payload so
  // it survives the IPC boundary intact.
  const bytesB64 = uint8ToBase64(bytes);
  chrome.runtime.sendMessage({
    type: "offscreen:audio_done",
    bytesB64,
    byteLength: bytes.byteLength,
    mimeType: chosenMime,
  } satisfies RuntimeMessage);
  recorder = null;
  stream = null;
  chunks = [];
}

function uint8ToBase64(buf: Uint8Array): string {
  // Chunked btoa to avoid call-stack blowups on multi-MB payloads.
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
