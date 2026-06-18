export type OsEventKind =
  | "os_click"
  | "os_mousedown"
  | "os_mouseup"
  | "os_keydown"
  | "os_keyup"
  | "os_wheel"
  | "web_event";

export interface OsEventModifiers {
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

export interface OsEventData {
  x?: number;
  y?: number;
  button?: number;
  clicks?: number;
  keycode?: number;
  keychar?: number;
  rawcode?: number;
  rotation?: number;
  direction?: number;
  modifiers?: OsEventModifiers;
  anchor_path?: string;
  // Browser-side annotations forwarded over the native-messaging bridge.
  // Interleaved into the recording's NDJSON timeline so replay analysis can
  // correlate OS clicks with DOM selectors / URLs.
  web_kind?: string;
  url?: string;
  title?: string;
  selector?: string;
  meta?: Record<string, unknown>;
}

export interface OsEvent {
  id: string;
  recording_id: string;
  ts_ms: number;
  kind: OsEventKind;
  data: OsEventData;
}

export interface CaptureSession {
  recording_id: string;
  started_at_ms: number;
  ended_at_ms?: number;
  event_count: number;
}

export type ReplayPhase =
  | "idle"
  | "countdown"
  | "running"
  | "done"
  | "aborted"
  | "error";

export interface ReplayProgress {
  recording_id: string | null;
  total: number;
  current: number;
  phase: ReplayPhase;
  message?: string;
}

export interface ReplayOptions {
  speed?: number;
  startDelayMs?: number;
  pruneInitialIdle?: boolean;
  useAnchors?: boolean;
}
