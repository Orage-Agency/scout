// Shared type contracts between background, content, offscreen, and popup.

export type EventKind =
  | "click"
  | "keydown"
  | "paste"
  | "copy"
  | "navigation"
  | "tab_switch"
  | "scroll"
  | "focus_change"
  | "select_change"
  | "checkbox_change"
  | "form_fill"
  | "tab_closed"
  | "screenshot_failed"
  | "coach_reply";

export interface SelectorDescriptor {
  strategy: "data-testid" | "id" | "aria-label" | "name" | "text" | "css";
  selector: string;
  tag: string;
  role?: string | null;
  visibleText?: string;
  bbox?: { x: number; y: number; w: number; h: number };
}

export interface CapturedEvent {
  // Set by service worker before persisting:
  recording_id?: string;
  user_id?: string;
  ts_ms: number;
  kind: EventKind;
  data: Record<string, unknown>;
  screenshot_path?: string | null;
  // Local-only: transient screenshot DataURL, dropped after upload.
  _screenshotDataUrl?: string;
  // Local-only: an idempotency key for de-duping retries.
  _localId: string;
}

export interface RecordingSessionState {
  recording_id: string;
  user_id: string;
  started_at: number; // epoch ms
  paused_ms: number;  // total time paused
  is_paused: boolean;
  audio_supported: boolean;
  mic_enabled: boolean;  // user opted in to voice narration
  mode: "skill" | "improvement"; // skill = workflow capture, improvement = critique brief
  ask_count: number;
  last_ask_at: number; // epoch ms; 0 if no ask yet
  event_count: number; // live counter for popup display
  shot_count: number;  // live counter of events with a screenshot attached
  active_tab_title?: string | null;
  active_tab_url?: string | null;
  live_transcript_tail?: string; // rolling 200-char buffer of Web Speech API results
}

export interface CoachAsk {
  ask: string | null;
}

export interface RecordingRow {
  id: string;
  user_id: string;
  title: string | null;
  mode?: "skill" | "improvement";
  status: "recording" | "uploading" | "transcribing" | "ready" | "failed";
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  audio_path: string | null;
  transcript: TranscriptShape | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface TranscriptSegment {
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface TranscriptShape {
  segments: TranscriptSegment[];
}

export interface SkillRow {
  id: string;
  recording_id: string;
  user_id: string;
  version: number;
  title: string | null;
  body_md: string;
  prompt_used: string | null;
  created_at: string;
  kind?: "skill" | "improvement";
}

// Service-worker ↔ popup ↔ content-script ↔ offscreen messages.
export type RuntimeMessage =
  | { type: "popup:start_recording"; mic_enabled?: boolean; mode?: "skill" | "improvement"; tier?: "quick" | "standard" | "deep" }
  | { type: "popup:stop_recording" }
  | { type: "popup:pause_recording" }
  | { type: "popup:resume_recording" }
  | { type: "popup:get_state" }
  | { type: "popup:state"; state: RecordingSessionState | null }
  | { type: "popup:counts"; event_count: number; shot_count: number; last_event_desc?: string }
  | { type: "popup:recording_changed"; recording_id: string; status: RecordingRow["status"] }
  | { type: "content:event"; event: CapturedEvent }
  | { type: "content:show_toast"; ask: string }
  | { type: "content:show_control_bar" }
  | { type: "content:hide_control_bar" }
  | { type: "offscreen:start_audio" }
  | { type: "offscreen:stop_audio" }
  | { type: "offscreen:audio_chunk"; chunk: ArrayBuffer; mimeType: string }
  | { type: "offscreen:audio_done"; bytesB64: string; byteLength: number; mimeType: string }
  | { type: "offscreen:audio_error"; error: string }
  | { type: "popup:generate_skill"; recording_id: string; extra?: string }
  | { type: "popup:skill_ready"; skill: SkillRow }
  | { type: "popup:skill_error"; error: string }
  | { type: "content:update_count"; event_count: number }
  | { type: "offscreen:live_transcript"; text: string };
