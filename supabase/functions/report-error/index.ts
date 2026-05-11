// /report-error — lightweight error ingestion from the extension.
// Receives a small, PII-free payload describing an unexpected failure so
// issues can be triaged without the user filing a support ticket.
//
// Auth is optional — errors can occur before the user is authenticated
// (e.g., Supabase env not configured). Unauthenticated reports are still
// accepted; we just won't have a user_id to correlate.
//
// TODO: wire up a persistence destination. Options:
//   A. Insert into a `error_reports` table (add migration + RLS).
//   B. POST to a Slack/Discord webhook (set SLACK_ERROR_WEBHOOK secret).
//   C. Leave as console-only — Supabase captures function logs centrally.
// Currently this function logs to console (option C). Supabase's function
// log viewer at dashboard → Edge Functions → report-error → Logs shows all
// invocations. Set up a log drain to ship to your observability stack.

import { corsHeaders, verifyAuthUser } from "../_shared/supabase.ts";

interface ErrorReport {
  extension_version: string;
  chrome_version?: string;
  recording_id?: string;
  last_error: string;
  context?: string;   // e.g. "flush", "transcribe", "coach"
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  const reqId = crypto.randomUUID().slice(0, 8);
  try {
    // Auth optional — best effort.
    const user = await verifyAuthUser(req.headers.get("authorization")).catch(() => null);

    let body: ErrorReport;
    try { body = (await req.json()) as ErrorReport; }
    catch { return json({ error: "invalid_json" }, 400); }

    if (!body.last_error) return json({ error: "missing last_error" }, 400);

    // Sanity-cap fields to prevent log flooding with oversized payloads.
    const report = {
      reqId,
      user_id:           user?.id ?? "anonymous",
      extension_version: String(body.extension_version ?? "unknown").slice(0, 20),
      chrome_version:    String(body.chrome_version    ?? "unknown").slice(0, 40),
      recording_id:      String(body.recording_id      ?? "").slice(0, 36) || null,
      context:           String(body.context           ?? "").slice(0, 40),
      last_error:        String(body.last_error).slice(0, 500),
    };

    // Log to Supabase function output (captured in the dashboard log viewer).
    console.log("[report-error]", JSON.stringify(report));

    // TODO: replace or supplement with a real sink when you have one.

    return json({ ok: true, reqId });
  } catch (err) {
    console.error(`[report-error ${reqId}]`, err);
    return json({ error: "internal" }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}
