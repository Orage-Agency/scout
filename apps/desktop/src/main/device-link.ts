// Device-link OAuth flow client + token refresh loop.
//
// The desktop client talks to the /device-link edge function through three
// touchpoints: start (mint a code), poll (wait for approval), and the auto
// refresh loop (use the refresh_token to renew the access_token before expiry).

import { getSettings, saveSettings } from "./settings";
import { logLine } from "./logger";

export interface DeviceCodeResp {
  device_code: string;
  user_code: string;
  verification_url: string;
  verification_url_complete: string;
  expires_in: number;
  interval: number;
}

export type PollStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "not_found"
  | "consumed";

export interface PollResp {
  status: PollStatus;
  access_token?: string;
  refresh_token?: string;
  user_id?: string;
  interval?: number;
}

function functionUrl(action: string): string {
  const s = getSettings();
  const base = (s.supabase_url ?? "").replace(/\/$/, "");
  if (!base) throw new Error("Supabase URL not configured");
  return `${base}/functions/v1/device-link?action=${action}`;
}

function publicHeaders(): Record<string, string> {
  const s = getSettings();
  const anon = s.supabase_anon_key ?? "";
  return {
    "Content-Type": "application/json",
    apikey: anon,
    Authorization: `Bearer ${anon}`,
  };
}

export async function startDeviceFlow(label: string): Promise<DeviceCodeResp> {
  const res = await fetch(functionUrl("start"), {
    method: "POST",
    headers: publicHeaders(),
    body: JSON.stringify({ label }),
  });
  if (!res.ok) {
    throw new Error(`device-link/start ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as DeviceCodeResp;
}

export async function pollDeviceFlow(deviceCode: string): Promise<PollResp> {
  const res = await fetch(functionUrl("poll"), {
    method: "POST",
    headers: publicHeaders(),
    body: JSON.stringify({ device_code: deviceCode }),
  });
  if (res.status === 404) return { status: "not_found" };
  if (!res.ok) {
    throw new Error(`device-link/poll ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as PollResp;
}

function jwtExpMs(jwt: string): number | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    ) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

let refreshTimer: NodeJS.Timeout | null = null;
let refreshInFlight: Promise<boolean> | null = null;

export function clearTokenRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

export function scheduleTokenRefresh(): void {
  clearTokenRefresh();
  const s = getSettings();
  if (!s.access_token || !s.refresh_token) return;
  const exp = jwtExpMs(s.access_token);
  if (!exp) return;
  // Refresh 60 s before expiry, with a 0-s floor for already-expired tokens.
  const delay = Math.max(0, exp - Date.now() - 60_000);
  refreshTimer = setTimeout(() => {
    void refreshTokens().catch(() => undefined);
  }, delay);
}

export async function refreshTokens(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh(): Promise<boolean> {
  const s = getSettings();
  if (!s.supabase_url || !s.supabase_anon_key || !s.refresh_token) return false;
  const url = `${s.supabase_url.replace(/\/$/, "")}/auth/v1/token?grant_type=refresh_token`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: s.supabase_anon_key,
      },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      await logLine(`[auth] refresh failed ${res.status}: ${txt}`);
      // 400 with "invalid_grant" → refresh token is dead. Clear so we surface
      // a "sign in again" state in the tray.
      if (res.status === 400 && txt.includes("invalid_grant")) {
        await saveSettings({ access_token: undefined, refresh_token: undefined, user_id: undefined });
        clearTokenRefresh();
      }
      return false;
    }
    const tokens = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
    };
    if (!tokens.access_token || !tokens.refresh_token) return false;
    await saveSettings({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      // user_id is re-derived from the new JWT on save.
      user_id: undefined,
    });
    scheduleTokenRefresh();
    await logLine(`[auth] refreshed access token`);
    return true;
  } catch (err) {
    await logLine(`[auth] refresh error: ${String(err)}`);
    return false;
  }
}

// Called before any outbound request that needs a fresh access_token. If the
// token expires in the next 60 s, do a synchronous refresh first.
export async function ensureFreshAccessToken(): Promise<void> {
  const s = getSettings();
  if (!s.access_token || !s.refresh_token) return;
  const exp = jwtExpMs(s.access_token);
  if (!exp) return;
  if (exp - Date.now() < 60_000) {
    await refreshTokens();
  }
}
