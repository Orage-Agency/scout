// Auto-wire the extension service worker to the Scout desktop tray via the
// native-messaging bridge.
//
// When the desktop tray is running, this opens a port to com.scout.desktop on
// SW wake-up and tracks the desktop's "is recording?" flag from broadcast
// state messages. The browser forwards a thin annotation track of navigation
// + click events while the desktop is recording — uiohook-napi sees a raw
// click at screen coordinates, the extension knows the URL and the selector
// of what was clicked. The two tracks merge into a single recording.
//
// Lazy and safe: if the desktop tray isn't installed/running, connect() falls
// through to the bridge's reconnect loop and forwardWebEvent silently no-ops.
// The extension's own recording pipeline is unaffected either way.

import {
  connect as bridgeConnect,
  forwardWebEvent,
  isDesktopConnected,
  onBridgeMessage,
} from "../lib/native-bridge";

interface DesktopState {
  recording: boolean;
  replaying: boolean;
  signed_in: boolean;
}

let desktopState: DesktopState = {
  recording: false,
  replaying: false,
  signed_in: false,
};

// Desktop publishes the state at the top level of the "state" / "welcome"
// message (is_capturing / is_replaying / is_signed_in), not nested under
// `state`. See apps/desktop/src/main/native-bridge.ts:snapshot().
function applyState(msg: Record<string, unknown>): void {
  if (typeof msg.is_capturing !== "boolean") return;
  desktopState = {
    recording: !!msg.is_capturing,
    replaying: !!msg.is_replaying,
    signed_in: !!msg.is_signed_in,
  };
}

export function isDesktopRecording(): boolean {
  return isDesktopConnected() && desktopState.recording;
}

export function getDesktopState(): DesktopState {
  return { ...desktopState };
}

export function initDesktopBridge(): void {
  onBridgeMessage((msg) => {
    // Tray broadcasts {type:"state", state:{...}} on every transition.
    if (msg.type === "state" || msg.type === "welcome") {
      applyState(msg as { state?: Partial<DesktopState> });
    }
  });
  // Best-effort: if the host isn't installed, connect() resolves with
  // connected:false and schedules its own retry — we don't care here.
  void bridgeConnect().catch(() => undefined);
}

export function forwardEvent(ev: {
  url: string | null;
  title?: string | null;
  selector?: string | null;
  kind: string;
  meta?: Record<string, unknown>;
}): void {
  if (!isDesktopRecording()) return;
  if (!ev.url) return;
  forwardWebEvent({
    url: ev.url,
    title: ev.title ?? undefined,
    selector: ev.selector ?? undefined,
    kind: ev.kind,
    meta: ev.meta,
  });
}
