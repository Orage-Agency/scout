// /device-link — RFC 8628-style device authorization grant.
//
// Actions (selected via ?action= or trailing path segment):
//   start    — public. Mint a (device_code, user_code) pair for a desktop client.
//   poll     — public. Desktop polls with device_code; once approved we hand back
//              a fresh access_token + refresh_token and mark the row consumed.
//   approve  — authenticated. The signed-in extension/web calls this with a
//              user_code to bind the device to the current user. We then mint a
//              fresh session via admin.generateLink + verifyOtp and stash the
//              tokens on the row for the desktop to pick up on its next poll.
//   deny     — authenticated. Marks the row 'denied' so the desktop stops polling.
//
// All actions return JSON. Status codes follow the device-grant convention where
// 'pending' is a 200 (the polling loop should continue) and only hard errors
// produce 4xx/5xx.

import { adminClient, corsHeaders, verifyAuthUser } from "../_shared/supabase.ts";

const POLL_INTERVAL_SEC = 5;
const CODE_TTL_SEC = 600;
const DEFAULT_VERIFICATION_URL =
  Deno.env.get("DEVICE_VERIFICATION_URL") ?? "https://scout.orage.agency/device";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

// Human-friendly 8-char code split as XXXX-XXXX. Alphabet excludes vowels (so
// it can't accidentally spell anything) plus 0/1/I/O (visually ambiguous).
function randomUserCode(): string {
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ23456789";
  const r = new Uint8Array(8);
  crypto.getRandomValues(r);
  const chars = Array.from(r, (n) => alphabet[n % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

async function startDevice(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { label?: string };
  const sb = adminClient();

  const deviceCode = randomHex(32);
  let userCode = randomUserCode();
  for (let i = 0; i < 5; i++) {
    const { data: clash } = await sb
      .from("device_codes")
      .select("id")
      .eq("user_code", userCode)
      .maybeSingle();
    if (!clash) break;
    userCode = randomUserCode();
  }

  const { error } = await sb.from("device_codes").insert({
    device_code: deviceCode,
    user_code: userCode,
    status: "pending",
    client_label: typeof body.label === "string" ? body.label.slice(0, 80) : null,
    expires_at: new Date(Date.now() + CODE_TTL_SEC * 1000).toISOString(),
  });
  if (error) return jsonResponse({ error: error.message }, 500);

  return jsonResponse({
    device_code: deviceCode,
    user_code: userCode,
    verification_url: DEFAULT_VERIFICATION_URL,
    verification_url_complete: `${DEFAULT_VERIFICATION_URL}?code=${encodeURIComponent(userCode)}`,
    expires_in: CODE_TTL_SEC,
    interval: POLL_INTERVAL_SEC,
  });
}

async function pollDevice(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { device_code?: string };
  if (!body.device_code) return jsonResponse({ error: "device_code required" }, 400);

  const sb = adminClient();
  const { data: row } = await sb
    .from("device_codes")
    .select("*")
    .eq("device_code", body.device_code)
    .maybeSingle();
  if (!row) return jsonResponse({ status: "not_found" }, 404);

  if (new Date(row.expires_at).getTime() < Date.now()) {
    if (row.status === "pending") {
      await sb.from("device_codes").update({ status: "expired" }).eq("id", row.id);
    }
    return jsonResponse({ status: "expired" });
  }

  await sb
    .from("device_codes")
    .update({ polled_at: new Date().toISOString() })
    .eq("id", row.id);

  if (row.status === "pending") {
    return jsonResponse({ status: "pending", interval: POLL_INTERVAL_SEC });
  }
  if (row.status === "denied") return jsonResponse({ status: "denied" });
  if (row.status === "approved") {
    await sb.from("device_codes").update({ status: "consumed" }).eq("id", row.id);
    return jsonResponse({
      status: "approved",
      access_token: row.access_token,
      refresh_token: row.refresh_token,
      user_id: row.user_id,
    });
  }
  return jsonResponse({ status: row.status });
}

async function mintSessionForUser(
  userId: string,
  email: string
): Promise<{ access_token: string; refresh_token: string } | { error: string }> {
  const sb = adminClient();
  const { data: link, error: linkErr } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr) return { error: `generateLink: ${linkErr.message}` };
  const hashedToken = link.properties?.hashed_token;
  if (!hashedToken) return { error: "no hashed_token in generateLink response" };

  // Prefer the auth project's GoTrue when configured; fall back to the data
  // project in single-project deployments.
  const url = Deno.env.get("AUTH_SUPABASE_URL") ?? Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("AUTH_SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;

  const verifyResp = await fetch(`${url}/auth/v1/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anon },
    body: JSON.stringify({ type: "magiclink", token_hash: hashedToken }),
  });
  if (!verifyResp.ok) {
    return {
      error: `verifyOtp ${verifyResp.status}: ${await verifyResp.text().catch(() => "")}`,
    };
  }
  const tokens = (await verifyResp.json()) as {
    access_token?: string;
    refresh_token?: string;
    user?: { id?: string };
  };
  if (!tokens.access_token || !tokens.refresh_token) {
    return { error: "no tokens in verifyOtp response" };
  }
  if (tokens.user?.id && tokens.user.id !== userId) {
    return { error: "minted session belongs to different user" };
  }
  return { access_token: tokens.access_token, refresh_token: tokens.refresh_token };
}

async function approveDevice(req: Request): Promise<Response> {
  const user = await verifyAuthUser(req.headers.get("Authorization"));
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  const body = (await req.json().catch(() => ({}))) as { user_code?: string };
  const rawCode = body.user_code?.toUpperCase().replace(/\s+/g, "").trim();
  if (!rawCode) return jsonResponse({ error: "user_code required" }, 400);
  // Tolerate codes pasted without the hyphen.
  const userCode =
    rawCode.length === 8 && !rawCode.includes("-")
      ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`
      : rawCode;

  const sb = adminClient();
  const { data: row } = await sb
    .from("device_codes")
    .select("*")
    .eq("user_code", userCode)
    .maybeSingle();
  if (!row) return jsonResponse({ error: "code not found" }, 404);
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return jsonResponse({ error: "code expired" }, 410);
  }
  if (row.status !== "pending") {
    return jsonResponse({ error: `code is ${row.status}` }, 409);
  }

  const { data: userInfo } = await sb.auth.admin.getUserById(user.id);
  const email = userInfo.user?.email;
  if (!email) return jsonResponse({ error: "user has no email on file" }, 400);

  const minted = await mintSessionForUser(user.id, email);
  if ("error" in minted) return jsonResponse({ error: minted.error }, 500);

  const { error: upErr } = await sb
    .from("device_codes")
    .update({
      status: "approved",
      user_id: user.id,
      access_token: minted.access_token,
      refresh_token: minted.refresh_token,
      approved_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (upErr) return jsonResponse({ error: upErr.message }, 500);

  return jsonResponse({ status: "approved", client_label: row.client_label });
}

async function denyDevice(req: Request): Promise<Response> {
  const user = await verifyAuthUser(req.headers.get("Authorization"));
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);
  const body = (await req.json().catch(() => ({}))) as { user_code?: string };
  if (!body.user_code) return jsonResponse({ error: "user_code required" }, 400);
  const sb = adminClient();
  await sb
    .from("device_codes")
    .update({ status: "denied" })
    .eq("user_code", body.user_code.toUpperCase().trim())
    .eq("status", "pending");
  return jsonResponse({ status: "denied" });
}

async function inspectCode(req: Request): Promise<Response> {
  // Used by the approval page to show the user "you're about to approve <label>"
  // before asking them to click. Authenticated to avoid leaking client labels.
  const user = await verifyAuthUser(req.headers.get("Authorization"));
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);
  const body = (await req.json().catch(() => ({}))) as { user_code?: string };
  if (!body.user_code) return jsonResponse({ error: "user_code required" }, 400);
  const userCode = body.user_code.toUpperCase().replace(/\s+/g, "").trim();
  const normalized =
    userCode.length === 8 && !userCode.includes("-")
      ? `${userCode.slice(0, 4)}-${userCode.slice(4)}`
      : userCode;
  const sb = adminClient();
  const { data: row } = await sb
    .from("device_codes")
    .select("status, client_label, expires_at")
    .eq("user_code", normalized)
    .maybeSingle();
  if (!row) return jsonResponse({ error: "code not found" }, 404);
  return jsonResponse({
    status: row.status,
    client_label: row.client_label,
    expires_at: row.expires_at,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const url = new URL(req.url);
  const action =
    url.searchParams.get("action") ?? url.pathname.split("/").filter(Boolean).pop();

  try {
    if (action === "start") return await startDevice(req);
    if (action === "poll") return await pollDevice(req);
    if (action === "approve") return await approveDevice(req);
    if (action === "deny") return await denyDevice(req);
    if (action === "inspect") return await inspectCode(req);
    return jsonResponse({ error: `unknown action: ${action}` }, 400);
  } catch (err) {
    return jsonResponse({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
