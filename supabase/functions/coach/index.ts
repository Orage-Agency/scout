// /coach — given a 30s window of events + a transcript tail, decide whether
// to ask the user a clarifying question. Default to silence. Per §9.

import { callLLM, MODEL_COACH } from "../_shared/llm.ts";
import { corsHeaders, verifyAuthUser } from "../_shared/supabase.ts";

const SYSTEM = `You are a quiet observer watching a person record a workflow.
Your job is to ask AT MOST ONE short question that will make the
skill file dramatically better. You only ask if asking is clearly
more valuable than staying silent. Default to silence.

Ask only when:
 - The user just made a non-obvious decision (e.g., chose option B
   when A and C were visible) and didn't narrate why.
 - The user pasted data and it's unclear where it came from.
 - The user paused for >20 seconds with no narration.
 - The user did something that looks rule-based but the rule isn't
   obvious from the screen alone.

Never ask when:
 - The user is mid-sentence narrating.
 - You asked a question in the last 60 seconds.
 - You've already asked 6+ questions this recording.
 - The action is self-explanatory (clicking 'Save' on a form).

Tone: warm junior teammate. Max 12 words. No jargon. No emojis.
Examples of good asks:
 - 'What made this one a yes vs. the others?'
 - 'Where did that customer ID come from?'
 - 'Is the deadline always 3 days, or does it vary?'

Output strict JSON only: {"ask": "..."} or {"ask": null}`;

interface CoachReq {
  events: Array<{ kind: string; ts_ms: number; data: Record<string, unknown> }>;
  transcript_tail?: string;
  ask_count?: number;
  current_url?: string | null;
  current_title?: string | null;
}

function summarizeCoachEvents(
  events: Array<{ kind: string; ts_ms: number; data: Record<string, unknown> }>
): string {
  const lines: string[] = [];
  for (const e of events) {
    const t = `${Math.round(e.ts_ms / 1000)}s`;
    if (e.kind === "click") {
      const tgt = e.data?.target as { visibleText?: string; selector?: string } | undefined;
      lines.push(`${t} click: ${tgt?.visibleText || tgt?.selector || "?"}`);
    } else if (e.kind === "keydown") {
      lines.push(`${t} key: ${e.data.key}`);
    } else if (e.kind === "paste") {
      lines.push(`${t} paste: "${((e.data.content_snippet as string) ?? "").slice(0, 40)}"`);
    } else if (e.kind === "navigation") {
      const rawUrl = String(e.data.to_url ?? "");
      let displayUrl = rawUrl;
      try { const u = new URL(rawUrl); displayUrl = u.hostname + (u.pathname.length > 40 ? u.pathname.slice(0, 37) + "…" : u.pathname); } catch { /* not a URL */ }
      lines.push(`${t} navigate: ${displayUrl}`);
    } else if (e.kind === "select_change") {
      lines.push(`${t} select: "${e.data.selected_text}"`);
    } else if (e.kind === "checkbox_change") {
      lines.push(`${t} ${e.data.checked ? "checked" : "unchecked"}: ${e.data.value ?? ""}`);
    } else if (e.kind === "form_fill") {
      const label = (e.data.field as { visibleText?: string; selector?: string } | undefined)?.visibleText
        ?? (e.data.field as { selector?: string } | undefined)?.selector ?? "field";
      lines.push(`${t} fill "${label}" = "${String(e.data.value ?? "").slice(0, 60)}"`);
    } else if (e.kind === "coach_reply") {
      lines.push(`${t} [user replied]: "${String(e.data.reply_text ?? "").slice(0, 100)}"`);
    } else {
      lines.push(`${t} ${e.kind}`);
    }
  }
  return lines.join("\n") || "(no recent actions)";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  try {
    // Auth gate: any logged-in user. Verified against the universal auth project.
    const user = await verifyAuthUser(req.headers.get("authorization"));
    if (!user) return json({ ask: null }, 401);

    const body = (await req.json()) as CoachReq;
    if ((body.ask_count ?? 0) >= 6) return json({ ask: null });

    const eventSummary = summarizeCoachEvents(body.events);
    let pageContext = "";
    if (body.current_url) {
      try {
        const u = new URL(body.current_url);
        pageContext = `\nCurrent page: ${u.hostname}${u.pathname.length > 48 ? u.pathname.slice(0, 45) + "…" : u.pathname}${body.current_title ? ` ("${body.current_title.slice(0, 60)}")` : ""}`;
      } catch { pageContext = `\nCurrent page: ${body.current_url.slice(0, 80)}`; }
    }
    const userMsg = `Recent actions (last 30s):
${eventSummary}
${pageContext}
Recent narration: ${body.transcript_tail || "(none)"}
Questions asked so far: ${body.ask_count ?? 0}`;

    const text = await callLLM({
      model: MODEL_COACH,
      max_tokens: 200,
      system: SYSTEM,
      temperature: 0.3,
      messages: [{ role: "user", content: userMsg }],
    });

    // Strict JSON parse with a fallback.
    let parsed: { ask: string | null } = { ask: null };
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        parsed = { ask: null };
      }
    }
    if (parsed.ask && typeof parsed.ask === "string") {
      // Cap length at 120 chars.
      parsed.ask = parsed.ask.slice(0, 120);
    } else {
      parsed.ask = null;
    }
    return json(parsed);
  } catch (err) {
    console.error("[coach]", err);
    return json({ ask: null, error: String((err as Error).message) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}
