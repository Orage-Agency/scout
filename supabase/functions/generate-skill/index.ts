// /generate-skill — fetch events + transcript + sampled screenshots, ask Claude
// to produce a SKILL.md, persist it. Per §10.

import { callLLM, MODEL_SKILL } from "../_shared/llm.ts";
import { adminClient, corsHeaders, verifyAuthUser } from "../_shared/supabase.ts";

const SYSTEM = `You will produce a SKILL.md file from a recorded human workflow.
An AI agent will read this file later and execute the task.
Your output must be ONLY the SKILL.md content — no preamble.

Use this exact frontmatter and structure:
---
name: <kebab-case-slug>
version: 1
description: <one sentence; the agent uses this to decide if this
             skill matches a request>
---

# <Human-readable title>

## Goal
<2-3 sentences. What outcome the user is trying to achieve.>

## When to use
<Bulleted list of triggering conditions. When should an agent run
this skill vs. a different one?>

## Inputs
<What information the agent needs before starting. Inferred from
what the human had to know.>

## Input examples
<For each {variable} declared below, give one realistic example value the
agent might receive. Format as a fenced JSON block (use three backticks
followed by "json"):

\`\`\`json
{ "variable_name": "example value" }
\`\`\`

This lets a future agent run the skill with sample inputs end-to-end. If
the workflow takes no inputs (Variables section says "(none)"), emit an
empty JSON object {} here.>

## Variables
<List ONLY the variables you actually reference as {placeholders} in the
Steps or Faster path sections below. Do not declare a variable you don't
use. Format each as:
  - {snake_case_name}: <description> (example: <value seen in recording>)

If the workflow takes no inputs (e.g., "archive all promotions"), write
exactly: "(none — this skill runs without parameters)" and skip directly
to Steps without inserting any placeholders.

Rules:
 - Replace the recorded example values with {snake_case_name} only when
   that value would genuinely change on a new run.
 - Constants (your own company name, fixed approver email) stay literal.
 - Prefer fewer variables: if three values always travel together
   (contact_name, contact_company, contact_email), pick the one the
   agent will actually need (usually contact_email) and drop the rest.>

## Steps
<Numbered list. Each step:
 - Describes the action in plain English (NOT 'click pixel 423,180')
 - Names the target element by visible text or aria-label
 - Notes any decision logic (e.g., 'if total > $500, also check X')
 - Describes the visible UI state in prose if it disambiguates the step
 - DO NOT embed image references like ![](step_3.png). The SKILL.md is
   text-only. Screenshots are available to the agent separately.>

## Faster path
<Analyze the workflow and propose a faster automated equivalent that
produces the SAME end result. CRITICAL: identify the service from the
domain in the recorded URLs (e.g., resend.com → Resend, hubspot.com →
HubSpot, app.hypefury.com → Hypefury). Use ONLY that service's API/CLI
— do not substitute a well-known alternative (e.g., do not propose
Mailchimp when the recording shows Resend). If the service has no
public API and no MCP, say so and suggest the Playwright MCP as a UI
automation fallback. Then suggest:
 - REST API calls (with HTTP method, endpoint, key params)
 - CLI commands (gh, supabase, vercel, gcloud, etc.)
 - MCP tool calls (if the service has a known MCP server: Notion, Linear,
   GitHub, Slack, Gmail, Google Calendar/Drive, Vercel, Supabase, Figma,
   Canva, n8n, Playwright)
 - Library/SDK calls (when an API is the right unit of work)
The cloud runtime that executes this skill will prefer this path over the
manual UI steps when the inputs allow it. Be specific — give the actual
endpoint, command, or tool name. If a step truly has no programmatic
equivalent (e.g., a captcha, a human approval), say so explicitly.
If the entire workflow is genuinely UI-only (no APIs/CLIs/MCPs apply),
write 'No faster automated path. Run the manual Steps above.' Do not
fabricate endpoints or invent CLIs that don't exist.>

## Decision rules
<Captured from the user's narration and the coach's asks. Explicit
rules that aren't obvious from the screen alone.>

## Edge cases
<Things that might go wrong and how the user handled them, if seen.
If not seen, write 'None observed.'>

## Done when
<How the agent knows the task succeeded.>`;

// Used when recording.mode === 'improvement'. Output is a paste-ready brief
// for Claude Code, not a SKILL.md. The user is critiquing an app they're
// looking at — the brief lists what's wrong, where, and how to fix it.
const IMPROVEMENT_SYSTEM = `You will produce a CHANGE BRIEF from a recorded
critique of an app. The user walked through their own app and pointed out
what they want changed: a broken layout, a confusing label, a feature that
should exist, a bug. The brief is written for Claude Code to read and
execute — paste-ready, no preamble.

Output structure (markdown only, no preamble, no fences around the whole
document):

---
kind: improvement
version: 1
description: <one sentence describing what should change overall>
---

# <Short, action-oriented title — e.g. "Fix mobile layout on /pricing">

## What's broken
<1-3 sentences. State the issue exactly as the user described it. Quote the
narration where helpful: "user said: ..."  Be concrete. No fluff.>

## Where to look
- **URL observed:** <full URL captured from the recording>
- **Element:** <visible text or selector — pull from the recorded clicks>
- **Likely file (best guess):** <Based on the URL path + framework hints in
  the screenshots, guess the file path. e.g. "/pricing → src/app/pricing/page.tsx
  in Next.js App Router". If you can't tell, write "unknown — search the repo
  for the visible string '<text>'.">

## Current behavior
<What's happening now, captured from the events + screenshots. One short
paragraph or bulleted list.>

## Desired behavior
<What the user said it should do. Take this from the narration.>

## Suggested change
<This is the most important section. Give Claude Code something concrete:

  Option A — when you can infer code: emit a fenced code block in the
  language you'd expect to find in that file (tsx, ts, css, sql, etc.).
  Mark each change with a clear "before" and "after" if it's a small edit.

  Option B — when you can't infer code: emit a precise instruction Claude
  Code can follow, e.g. "In <likely file>, locate the <ComponentName>
  component and change <prop> from X to Y. Make sure <related thing> is
  updated too."

  Either way: name files, name functions, name variables. Never write
  vague stuff like "improve the styling".>

## Acceptance criteria
- [ ] <Specific, observable bullet — what does success look like?>
- [ ] <Edge case to confirm.>

## Open questions
<Anything you're unsure about that Claude Code should ask the human before
acting. If nothing, write "None.">

CRITICAL rules:
 - The user is showing you their OWN app. Trust their narration as the
   source of truth.
 - Always anchor on the recorded URL and visible text — those are the
   strongest signals about which file holds the relevant code.
 - Do NOT embed image references like ![](shot.png). The brief is
   text-only; screenshots are attached separately for your reference.
 - Output ONLY the markdown brief. No preamble, no "Here is your brief:".`;

interface GenReq {
  recording_id: string;
  extra?: string;
}

const MAX_SCREENSHOTS = 12;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  try {
    const user = await verifyAuthUser(req.headers.get("authorization"));
    if (!user) return json({ error: "unauthorized" }, 401);

    const { recording_id, extra } = (await req.json()) as GenReq;
    if (!recording_id) return json({ error: "missing recording_id" }, 400);

    const admin = adminClient();
    const { data: rec, error: recErr } = await admin
      .from("recordings")
      .select("*")
      .eq("id", recording_id)
      .eq("user_id", user.id)
      .single();
    if (recErr || !rec) return json({ error: "recording_not_found" }, 404);

    const { data: events } = await admin
      .from("events")
      .select("ts_ms,kind,data,screenshot_path")
      .eq("recording_id", recording_id)
      .order("ts_ms", { ascending: true });
    const { data: coachLog } = await admin
      .from("coach_log")
      .select("asked_at_ms,ask_text,reply_transcript")
      .eq("recording_id", recording_id)
      .order("asked_at_ms", { ascending: true });

    const sampledPaths = sampleScreenshots(events ?? [], coachLog ?? []);
    const images: Array<{ type: "image"; source: { type: "base64"; media_type: string; data: string } }> = [];
    for (const path of sampledPaths) {
      const { data: blob } = await admin.storage.from("screenshots").download(path);
      if (!blob) continue;
      const ab = await blob.arrayBuffer();
      const b64 = bufToBase64(new Uint8Array(ab));
      images.push({
        type: "image",
        source: { type: "base64", media_type: blob.type || "image/jpeg", data: b64 },
      });
    }

    const transcriptText = (rec.transcript?.segments ?? [])
      .map((s: { start_ms: number; text: string }) => `[${Math.round(s.start_ms / 1000)}s] ${s.text}`)
      .join("\n");

    const isImprovement = rec.mode === "improvement";
    const systemPrompt = isImprovement ? IMPROVEMENT_SYSTEM : SYSTEM;
    const headerLine = isImprovement
      ? "Now produce the CHANGE BRIEF from these materials."
      : "Now produce the SKILL.md from these materials.";
    const userPrompt = `${headerLine}${extra ? `\nExtra guidance from the user: ${extra}` : ""}

EVENTS (${events?.length ?? 0} total, summarized):
${summarizeEvents(events ?? [])}

TRANSCRIPT:
${transcriptText || "(no narration)"}

COACH ASKS AND REPLIES:
${(coachLog ?? []).map((c) => `Q (${Math.round(c.asked_at_ms / 1000)}s): ${c.ask_text}\nA: ${c.reply_transcript ?? "(no recorded reply)"}`).join("\n\n") || "(none)"}

SCREENSHOTS: ${images.length} attached as image blocks below.`;

    const content: Array<unknown> = [{ type: "text", text: userPrompt }];
    for (const img of images) content.push(img);

    // deno-lint-ignore no-explicit-any
    const md = await callLLM({
      model: MODEL_SKILL,
      max_tokens: 3500,
      system: systemPrompt,
      temperature: 0.4,
      messages: [{ role: "user", content: content as any }],
    });

    // Pull a title and slug from the frontmatter for storage.
    const slug = (md.match(/^name:\s*(.+)$/m)?.[1] ?? "skill").trim();
    const title = (md.match(/^#\s+(.+)$/m)?.[1] ?? slug).trim();

    // New version = max(existing) + 1.
    const { data: existing } = await admin
      .from("skills")
      .select("version")
      .eq("recording_id", recording_id)
      .order("version", { ascending: false })
      .limit(1);
    const version = ((existing?.[0]?.version as number | undefined) ?? 0) + 1;

    const { data: inserted, error: insErr } = await admin
      .from("skills")
      .insert({
        recording_id,
        user_id: user.id,
        version,
        title,
        body_md: md,
        kind: isImprovement ? "improvement" : "skill",
        prompt_used: systemPrompt,
      })
      .select("*")
      .single();
    if (insErr) return json({ error: insErr.message }, 500);

    // Backfill the recording row's title if it's still null. The library tab
    // falls back to "Untitled recording" otherwise.
    if (!rec.title) {
      await admin.from("recordings").update({ title }).eq("id", recording_id);
    }

    return json(inserted);
  } catch (err) {
    console.error("[generate-skill]", err);
    return json({ error: String((err as Error).message) }, 500);
  }
});

// Sample first, last, one per "major UI state" (URL change held >5s), and any
// screenshot at a coach-ask moment. Cap at 12.
function sampleScreenshots(
  events: Array<{ ts_ms: number; kind: string; data: Record<string, unknown>; screenshot_path: string | null }>,
  coachLog: Array<{ asked_at_ms: number }>,
): string[] {
  const withPath = events.filter((e) => e.screenshot_path);
  if (withPath.length === 0) return [];
  const out = new Set<string>();
  // First and last.
  out.add(withPath[0].screenshot_path!);
  out.add(withPath[withPath.length - 1].screenshot_path!);
  // Coach ask moments — closest event by ts_ms.
  for (const ask of coachLog) {
    const closest = withPath.reduce((best, e) =>
      Math.abs(e.ts_ms - ask.asked_at_ms) < Math.abs(best.ts_ms - ask.asked_at_ms) ? e : best,
    withPath[0]);
    if (closest.screenshot_path) out.add(closest.screenshot_path);
  }
  // Major UI state heuristic: detect URL changes (navigation events) and pick
  // the screenshot ~5s after each.
  for (const e of events) {
    if (e.kind === "navigation") {
      const after = withPath.find((x) => x.ts_ms >= e.ts_ms + 5000);
      if (after?.screenshot_path) out.add(after.screenshot_path);
      if (out.size >= MAX_SCREENSHOTS) break;
    }
  }
  // Top up with evenly spaced shots.
  if (out.size < MAX_SCREENSHOTS) {
    const stride = Math.max(1, Math.floor(withPath.length / (MAX_SCREENSHOTS - out.size)));
    for (let i = 0; i < withPath.length && out.size < MAX_SCREENSHOTS; i += stride) {
      if (withPath[i].screenshot_path) out.add(withPath[i].screenshot_path!);
    }
  }
  return Array.from(out).slice(0, MAX_SCREENSHOTS);
}

function summarizeEvents(events: Array<{ ts_ms: number; kind: string; data: Record<string, unknown> }>): string {
  // Compress for the prompt — Claude doesn't need every scroll.
  const lines: string[] = [];
  for (const e of events) {
    if (e.kind === "scroll") continue;
    const t = `${Math.round(e.ts_ms / 1000)}s`;
    if (e.kind === "click") {
      const tgt = (e.data?.target as { strategy: string; selector: string; visibleText?: string } | undefined);
      lines.push(`${t} click ${tgt?.visibleText || tgt?.selector || "?"}`);
    } else if (e.kind === "keydown") {
      lines.push(`${t} keydown ${(e.data as Record<string, unknown>).key}`);
    } else if (e.kind === "paste") {
      lines.push(`${t} paste "${((e.data as Record<string, unknown>).content_snippet as string) ?? ""}"`);
    } else if (e.kind === "navigation") {
      lines.push(`${t} navigate -> ${(e.data as Record<string, unknown>).to_url}`);
    } else if (e.kind === "tab_switch") {
      lines.push(`${t} tab_switch -> ${(e.data as Record<string, unknown>).to_tab_url}`);
    } else {
      lines.push(`${t} ${e.kind}`);
    }
    if (lines.length > 200) {
      lines.push("…(truncated for prompt)");
      break;
    }
  }
  return lines.join("\n");
}

function bufToBase64(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return btoa(s);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}
