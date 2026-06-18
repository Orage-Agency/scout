// Native-messaging client to the Scout desktop tray app.
//
// The desktop registers a Chrome native-messaging host "com.scout.desktop"
// that forwards JSON messages to/from the running tray (see apps/desktop/
// scripts/native-host.js). This module wraps chrome.runtime.connectNative
// with promise-based send + a small event bus for unsolicited messages from
// the tray (e.g. state changes when the user starts recording from the tray).
//
// The host is optional: if the desktop app isn't installed/running, connect()
// resolves with `connected: false`. Callers can use isDesktopConnected() to
// gate features that depend on the bridge.

const HOST_NAME = "com.scout.desktop";

export type BridgeMessage = {
  type: string;
  [k: string]: unknown;
};

type Listener = (msg: BridgeMessage) => void;

interface BridgeState {
  port: chrome.runtime.Port | null;
  connected: boolean;
  desktopVersion: string | null;
  pending: Map<string, (msg: BridgeMessage) => void>;
  listeners: Set<Listener>;
  reconnectTimer: number | null;
  manualClose: boolean;
}

const state: BridgeState = {
  port: null,
  connected: false,
  desktopVersion: null,
  pending: new Map(),
  listeners: new Set(),
  reconnectTimer: null,
  manualClose: false,
};

function tryConnect(): chrome.runtime.Port | null {
  try {
    return chrome.runtime.connectNative(HOST_NAME);
  } catch {
    return null;
  }
}

function scheduleReconnect(): void {
  if (state.manualClose) return;
  if (state.reconnectTimer != null) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connect();
  }, 10_000) as unknown as number;
}

function handleIncoming(msg: BridgeMessage): void {
  if (typeof msg.req_id === "string") {
    const resolver = state.pending.get(msg.req_id);
    if (resolver) {
      state.pending.delete(msg.req_id);
      resolver(msg);
      return;
    }
  }
  if (msg.type === "welcome" && typeof msg.desktop_version === "string") {
    state.desktopVersion = msg.desktop_version;
  }
  for (const l of state.listeners) {
    try {
      l(msg);
    } catch (err) {
      console.warn("[scout-bridge] listener threw", err);
    }
  }
}

export async function connect(): Promise<{ connected: boolean; desktopVersion: string | null }> {
  if (state.connected && state.port) {
    return { connected: true, desktopVersion: state.desktopVersion };
  }
  const port = tryConnect();
  if (!port) {
    scheduleReconnect();
    return { connected: false, desktopVersion: null };
  }
  state.port = port;
  state.manualClose = false;

  let resolved = false;
  return new Promise((resolve) => {
    const settle = (ok: boolean) => {
      if (resolved) return;
      resolved = true;
      resolve({ connected: ok, desktopVersion: state.desktopVersion });
    };

    port.onMessage.addListener((msg: BridgeMessage) => {
      if (!state.connected) {
        state.connected = true;
        settle(true);
      }
      handleIncoming(msg);
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message ?? null;
      state.connected = false;
      state.port = null;
      // Resolve any pending requests with a disconnect error.
      for (const resolver of state.pending.values()) {
        resolver({ type: "error", error: err ?? "disconnected" });
      }
      state.pending.clear();
      if (!resolved) settle(false);
      scheduleReconnect();
    });

    // Send hello to kick off; the tray responds with "welcome" + state which
    // triggers settle(true) above.
    try {
      port.postMessage({
        type: "hello",
        extension_version: chrome.runtime.getManifest().version,
      });
    } catch {
      settle(false);
    }

    // Connection-timeout safety net.
    setTimeout(() => settle(false), 5_000);
  });
}

export function disconnect(): void {
  state.manualClose = true;
  if (state.reconnectTimer != null) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.port) {
    try {
      state.port.disconnect();
    } catch {
      /* ignore */
    }
    state.port = null;
  }
  state.connected = false;
}

export function isDesktopConnected(): boolean {
  return state.connected;
}

export function onBridgeMessage(fn: Listener): () => void {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

let reqCounter = 0;
export function send<T extends BridgeMessage = BridgeMessage>(
  msg: BridgeMessage,
  opts: { timeoutMs?: number } = {}
): Promise<T> {
  if (!state.port || !state.connected) {
    return Promise.reject(new Error("desktop bridge not connected"));
  }
  const reqId = `r${++reqCounter}`;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(reqId);
      reject(new Error(`bridge timeout: ${msg.type}`));
    }, timeoutMs);
    state.pending.set(reqId, (response) => {
      clearTimeout(timer);
      resolve(response as T);
    });
    try {
      state.port!.postMessage({ ...msg, req_id: reqId });
    } catch (err) {
      clearTimeout(timer);
      state.pending.delete(reqId);
      reject(err);
    }
  });
}

// ---- Convenience wrappers ----

export async function fireAndForget(msg: BridgeMessage): Promise<void> {
  if (!state.port || !state.connected) return;
  try {
    state.port.postMessage(msg);
  } catch {
    /* ignore */
  }
}

export async function getDesktopState(): Promise<BridgeMessage> {
  return send({ type: "get_state" });
}

export async function startDesktopRecording(): Promise<BridgeMessage> {
  return send({ type: "start_recording" });
}

export async function stopDesktopRecording(): Promise<BridgeMessage> {
  return send({ type: "stop_recording" });
}

export async function adoptDesktopSession(
  accessToken: string,
  refreshToken: string
): Promise<BridgeMessage> {
  return send({
    type: "adopt_session",
    access_token: accessToken,
    refresh_token: refreshToken,
  });
}

export function forwardWebEvent(payload: {
  url: string;
  title?: string;
  selector?: string;
  kind: string;
  meta?: Record<string, unknown>;
}): void {
  // Fire-and-forget — web events are an annotation track; we don't want to
  // block the page on bridge acks.
  void fireAndForget({ type: "web_event", ...payload });
}
