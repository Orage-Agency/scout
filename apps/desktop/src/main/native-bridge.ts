// Local-loopback bridge between the desktop tray app and the Chrome extension.
//
// Architecture:
//   Chrome  ─stdio(NM proto)─▶ scripts/native-host.js  ─TCP 127.0.0.1:5391─▶  this server
//
// Why a broker process rather than letting Chrome talk to the tray directly:
//   - Chrome native messaging spawns a fresh process for each connect, but we
//     want a singleton tray app that owns capture/replay state.
//   - The broker (native-host.js) is a tiny stdio↔socket relay with no Electron
//     overhead, runs only for the lifetime of a connection, and forwards
//     newline-delimited JSON to the long-running tray.
//
// Security:
//   - Bound to 127.0.0.1 only. Off-host traffic is rejected by the kernel,
//     not by us.
//   - The broker is only reachable from chrome-extension://<our extension id>,
//     enforced by the native-messaging manifest's allowed_origins. So even
//     though the TCP port is "open", only our own extension can ride the
//     broker that connects to it.
//   - The bridge does NOT expose arbitrary IPC. It accepts a small explicit
//     vocabulary of commands.

import { createServer, type Server, type Socket } from "node:net";
import { logLine } from "./logger";
import {
  getActiveSession,
  isCapturing,
  startCapture,
  stopCapture,
} from "./capture";
import { isReplaying, requestAbort, runEvents } from "./replay";
import { getLastRecording, listRecordings, loadEvents } from "./recordings";
import { getSettings, isConfigured, saveSettings } from "./settings";
import { scheduleTokenRefresh } from "./device-link";

export const BRIDGE_PORT = 5391;

type IncomingMsg =
  | { type: "hello"; extension_version?: string; user_id?: string }
  | { type: "get_state" }
  | { type: "start_recording" }
  | { type: "stop_recording" }
  | { type: "replay_last" }
  | { type: "abort_replay" }
  | { type: "adopt_session"; access_token: string; refresh_token: string }
  | {
      type: "web_event";
      url: string;
      title?: string;
      selector?: string;
      kind: string;
      meta?: Record<string, unknown>;
    };

interface OutgoingMsg {
  type: string;
  ok?: boolean;
  error?: string;
  [k: string]: unknown;
}

let server: Server | null = null;
const sockets = new Set<Socket>();

function send(socket: Socket, msg: OutgoingMsg): void {
  try {
    socket.write(JSON.stringify(msg) + "\n");
  } catch {
    /* socket closing */
  }
}

function broadcast(msg: OutgoingMsg): void {
  for (const s of sockets) send(s, msg);
}

function snapshot(): OutgoingMsg {
  const session = getActiveSession();
  return {
    type: "state",
    is_capturing: isCapturing(),
    is_replaying: isReplaying(),
    is_signed_in: isConfigured(),
    active_recording_id: session?.recording_id ?? null,
    event_count: session?.event_count ?? null,
  };
}

async function handleMsg(socket: Socket, raw: IncomingMsg): Promise<void> {
  switch (raw.type) {
    case "hello": {
      await logLine(
        `[bridge] hello ext_ver=${raw.extension_version ?? "?"} user=${raw.user_id ?? "?"}`
      );
      send(socket, {
        type: "welcome",
        desktop_version: process.env.npm_package_version ?? "dev",
        ...snapshot(),
      });
      return;
    }
    case "get_state": {
      send(socket, snapshot());
      return;
    }
    case "start_recording": {
      if (isReplaying()) {
        send(socket, { type: "ack", ok: false, error: "replay in progress" });
        return;
      }
      if (isCapturing()) {
        send(socket, { type: "ack", ok: true, already: true, ...snapshot() });
        return;
      }
      const sess = await startCapture();
      await logLine(`[bridge] start id=${sess.recording_id}`);
      send(socket, { type: "ack", ok: true, recording_id: sess.recording_id });
      broadcast(snapshot());
      return;
    }
    case "stop_recording": {
      if (!isCapturing()) {
        send(socket, { type: "ack", ok: false, error: "not recording" });
        return;
      }
      const done = await stopCapture();
      await logLine(`[bridge] stop events=${done?.event_count ?? 0}`);
      send(socket, {
        type: "ack",
        ok: true,
        recording_id: done?.recording_id,
        event_count: done?.event_count,
      });
      broadcast(snapshot());
      return;
    }
    case "replay_last": {
      const last = await getLastRecording();
      if (!last) {
        send(socket, { type: "ack", ok: false, error: "no recordings" });
        return;
      }
      send(socket, { type: "ack", ok: true, recording_id: last.recording_id });
      // Fire-and-forget — replay drives its own progress events; failures are
      // surfaced via the state snapshot.
      void (async () => {
        try {
          const events = await loadEvents(last.events_file);
          await runEvents(events, last.recording_id, last.dir);
        } catch (err) {
          await logLine(`[bridge] replay error: ${String(err)}`);
        }
      })();
      return;
    }
    case "abort_replay": {
      if (isReplaying()) requestAbort();
      send(socket, { type: "ack", ok: true });
      return;
    }
    case "adopt_session": {
      // Web side has a valid Supabase session; transfer it to the desktop so
      // the user doesn't have to round-trip through the device-link flow. We
      // trust the broker because only our own extension can connect.
      if (!raw.access_token || !raw.refresh_token) {
        send(socket, { type: "ack", ok: false, error: "missing tokens" });
        return;
      }
      await saveSettings({
        access_token: raw.access_token,
        refresh_token: raw.refresh_token,
        user_id: undefined,
      });
      scheduleTokenRefresh();
      await logLine(`[bridge] adopted session from extension`);
      send(socket, { type: "ack", ok: true, user_id: getSettings().user_id });
      broadcast(snapshot());
      return;
    }
    case "web_event": {
      // Browser-side context attached to whatever recording is active. We
      // forward it through to the existing event sink as a synthetic OS event
      // with kind="web_*" so the NDJSON timeline interleaves with mouse/key.
      if (!isCapturing()) {
        send(socket, { type: "ack", ok: false, error: "not recording" });
        return;
      }
      const { appendWebEvent } = await import("./capture");
      const ok = await appendWebEvent({
        url: raw.url,
        title: raw.title,
        selector: raw.selector,
        kind: raw.kind,
        meta: raw.meta,
      });
      send(socket, { type: "ack", ok });
      return;
    }
    default: {
      send(socket, { type: "ack", ok: false, error: `unknown type: ${(raw as { type?: string }).type}` });
    }
  }
}

function attachSocket(socket: Socket): void {
  sockets.add(socket);
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    let i = buf.indexOf("\n");
    while (i !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        try {
          const parsed = JSON.parse(line) as IncomingMsg;
          void handleMsg(socket, parsed).catch((err) =>
            logLine(`[bridge] handler error: ${String(err)}`)
          );
        } catch {
          send(socket, { type: "ack", ok: false, error: "invalid json" });
        }
      }
      i = buf.indexOf("\n");
    }
  });
  socket.on("close", () => {
    sockets.delete(socket);
  });
  socket.on("error", (err) => {
    void logLine(`[bridge] socket error: ${String(err)}`);
    sockets.delete(socket);
  });
}

export function startBridgeServer(): void {
  if (server) return;
  server = createServer((socket) => {
    if (socket.remoteAddress !== "127.0.0.1" && socket.remoteAddress !== "::1") {
      socket.destroy();
      return;
    }
    attachSocket(socket);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    void logLine(`[bridge] server error: ${err.code ?? ""} ${String(err)}`);
    // EADDRINUSE → another scout-desktop instance already owns the port; we
    // silently back off rather than crash, since the tray can run without
    // the bridge.
    if (err.code === "EADDRINUSE") {
      server = null;
    }
  });
  server.listen(BRIDGE_PORT, "127.0.0.1", () => {
    void logLine(`[bridge] listening on 127.0.0.1:${BRIDGE_PORT}`);
  });
}

export function broadcastBridgeState(): void {
  broadcast(snapshot());
}

export function stopBridgeServer(): void {
  for (const s of sockets) s.destroy();
  sockets.clear();
  server?.close();
  server = null;
}
