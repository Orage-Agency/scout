import { getSettings } from "./settings";
import { ensureFreshAccessToken, refreshTokens } from "./device-link";

export interface RecordingRow {
  id: string;
  user_id: string;
  status: string;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
}

export interface EventRow {
  id: string;
  recording_id: string;
  user_id: string;
  ts_ms: number;
  kind: string;
  data: unknown;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const s = getSettings();
  return {
    "Content-Type": "application/json",
    apikey: s.supabase_anon_key ?? "",
    Authorization: `Bearer ${s.access_token ?? ""}`,
    Prefer: "return=minimal",
    ...extra,
  };
}

function baseUrl(): string {
  const s = getSettings();
  if (!s.supabase_url) throw new Error("Supabase URL not configured");
  return s.supabase_url.replace(/\/$/, "");
}

async function authedFetch(
  url: string,
  init: RequestInit,
  label: string
): Promise<Response> {
  await ensureFreshAccessToken();
  let res = await fetch(url, withCurrentAuth(init));
  if (res.status === 401) {
    // Token went stale between our pre-check and the request — try one refresh,
    // then retry once with the freshly-saved Authorization header.
    const ok = await refreshTokens();
    if (ok) res = await fetch(url, withCurrentAuth(init));
  }
  if (!res.ok) {
    throw new Error(`${label} ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return res;
}

function withCurrentAuth(init: RequestInit): RequestInit {
  const s = getSettings();
  const prev = (init.headers ?? {}) as Record<string, string>;
  return {
    ...init,
    headers: {
      ...prev,
      Authorization: `Bearer ${s.access_token ?? ""}`,
    },
  };
}

export async function upsertRecording(row: RecordingRow): Promise<void> {
  const url = `${baseUrl()}/rest/v1/recordings?on_conflict=id`;
  await authedFetch(
    url,
    {
      method: "POST",
      headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(row),
    },
    "upsertRecording"
  );
}

export async function patchRecording(
  id: string,
  patch: Record<string, unknown>
): Promise<void> {
  const url = `${baseUrl()}/rest/v1/recordings?id=eq.${encodeURIComponent(id)}`;
  await authedFetch(
    url,
    { method: "PATCH", headers: headers(), body: JSON.stringify(patch) },
    "patchRecording"
  );
}

export async function insertEvents(events: EventRow[]): Promise<void> {
  if (events.length === 0) return;
  const url = `${baseUrl()}/rest/v1/events`;
  await authedFetch(
    url,
    { method: "POST", headers: headers(), body: JSON.stringify(events) },
    "insertEvents"
  );
}

export async function uploadToStorage(
  bucket: string,
  objectPath: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  const safePath = objectPath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const url = `${baseUrl()}/storage/v1/object/${bucket}/${safePath}`;
  const s = getSettings();
  await authedFetch(
    url,
    {
      method: "POST",
      headers: {
        apikey: s.supabase_anon_key ?? "",
        Authorization: `Bearer ${s.access_token ?? ""}`,
        "Content-Type": contentType,
        "x-upsert": "true",
      },
      body,
    },
    `uploadToStorage ${bucket}/${objectPath}`
  );
}
