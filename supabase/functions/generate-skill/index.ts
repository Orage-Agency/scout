// /generate-skill — fetch events + transcript + sampled screenshots, ask Claude
// to produce a SKILL.md, persist it. Per §10.

import { callLLM, callLLMStream } from "../_shared/llm.ts";

// Tier → model + image strategy. Defaults to Standard. Tier comes from
// recording.meta.tier (set by the popup when the recording starts).
type Tier = "quick" | "standard" | "deep";
function tierConfig(tier: Tier): {
  model: string;
  max_tokens: number;
  skillImages: "none" | "conditional" | "all";
  improvementImages: "few" | "all";
} {
  if (tier === "quick") {
    return { model: "claude-haiku-4-5", max_tokens: 1500, skillImages: "none", improvementImages: "few" };
  }
  if (tier === "deep") {
    return { model: "claude-opus-4-7", max_tokens: 5000, skillImages: "all", improvementImages: "all" };
  }
  // standard (default)
  return { model: "claude-sonnet-4-6", max_tokens: 3500, skillImages: "conditional", improvementImages: "all" };
}
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
 - DO NOT embed image references like ![](step_3.png). The SKILL.md must
   be self-contained text. Screenshots are provided to you during generation
   for context only — they are NOT available when the skill is executed.>

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

    // Pick tier config from recording.meta.tier. Tier governs model,
    // max_tokens, and how many images to attach to each prompt.
    const tier: Tier = ((rec.meta as { tier?: string } | null)?.tier as Tier) ?? "standard";
    const cfg = tierConfig(tier);
    const sampledPaths = sampleScreenshots(events ?? [], coachLog ?? []);
    const allImages: Array<{ type: "image"; source: { type: "base64"; media_type: string; data: string } }> = [];
    for (const path of sampledPaths) {
      const { data: blob } = await admin.storage.from("screenshots").download(path);
      if (!blob) continue;
      const ab = await blob.arrayBuffer();
      const b64 = bufToBase64(new Uint8Array(ab));
      allImages.push({
        type: "image",
        source: { type: "base64", media_type: blob.type || "image/jpeg", data: b64 },
      });
    }
    // Image counts per tier:
    //   Quick:    skill = 0   (text signal only), improvement = first 4
    //   Standard: skill = 0 if click text is strong, else first 6; improvement = all
    //   Deep:     all images for both
    const textSignalStrong = eventsHaveStrongTextSignal(events ?? []);
    const imagesForSkill =
      cfg.skillImages === "all" ? allImages
      : cfg.skillImages === "conditional"
        ? (textSignalStrong ? [] : allImages.slice(0, 6))
        : []; // "none"
    const imagesForImprovement =
      cfg.improvementImages === "all" ? allImages : allImages.slice(0, 4);
    console.log(
      `[generate-skill] tier=${tier} model=${cfg.model} skill_imgs=${imagesForSkill.length} improv_imgs=${imagesForImprovement.length} text_strong=${textSignalStrong}`,
    );

    const transcriptText = (rec.transcript?.segments ?? [])
      .map((s: { start_ms: number; text: string }) => `[${Math.round(s.start_ms / 1000)}s] ${s.text}`)
      .join("\n");

    const baseUserPrompt = (header: string) => `${header}${extra ? `\nExtra guidance from the user: ${extra}` : ""}

EVENTS (${events?.length ?? 0} total, summarized):
${summarizeEvents(events ?? [])}

TRANSCRIPT:
${transcriptText || "(no narration)"}

COACH ASKS AND REPLIES:
${(coachLog ?? []).map((c) => `Q (${Math.round(c.asked_at_ms / 1000)}s): ${c.ask_text}\nA: ${c.reply_transcript ?? "(no recorded reply)"}`).join("\n\n") || "(none)"}

SCREENSHOTS: {{IMAGE_COUNT}} attached as image blocks below.`;

    const buildContent = (header: string, imgs: typeof allImages): unknown[] => {
      const text = baseUserPrompt(header).replace("{{IMAGE_COUNT}}", String(imgs.length));
      const c: unknown[] = [{ type: "text", text }];
      for (let i = 0; i < imgs.length; i++) {
        // Cache-control on the LAST image so the entire user-message prefix
        // (text + all images) is cacheable as a unit. Subsequent calls with
        // the same prefix get the 90% discount on these tokens.
        const isLast = i === imgs.length - 1;
        c.push(isLast ? { ...imgs[i], cache_control: { type: "ephemeral" } } : imgs[i]);
      }
      return c;
    };

    // Stream the skill and run improvement concurrently.
    // The popup receives SSE events: skill_chunk (live text), done (full rows).
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();

    const send = async (data: unknown): Promise<void> => {
      try {
        await writer.write(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
      } catch { /* client disconnected */ }
    };

    // Run the full generation pipeline in the background so we can return
    // the streaming response immediately.
    (async () => {
      try {
        // Start improvement immediately (non-streaming) so it runs in parallel
        // while skill content streams to the client.
        // deno-lint-ignore no-explicit-any
        const improvementPromise = callLLM({
          model: cfg.model,
          max_tokens: cfg.max_tokens,
          system: IMPROVEMENT_SYSTEM,
          temperature: 0.4,
          messages: [{ role: "user", content: buildContent("Now produce the CHANGE BRIEF from these materials.", imagesForImprovement) as any }],
        });

        // Stream skill content chunk by chunk to the popup.
        let skillMd = "";
        // deno-lint-ignore no-explicit-any
        const skillStream = callLLMStream({
          model: cfg.model,
          max_tokens: cfg.max_tokens,
          system: SYSTEM,
          temperature: 0.4,
          messages: [{ role: "user", content: buildContent("Now produce the SKILL.md from these materials.", imagesForSkill) as any }],
        });
        for await (const chunk of skillStream) {
          skillMd += chunk;
          await send({ type: "skill_chunk", text: chunk });
        }

        // By the time skill streaming finishes, improvement is likely done.
        const improvementMd = await improvementPromise;

        const skillSlug  = (skillMd.match(/^name:\s*(.+)$/m)?.[1] ?? "skill").trim();
        const skillTitle = (skillMd.match(/^#\s+(.+)$/m)?.[1] ?? skillSlug).trim();
        const improvementTitle = (improvementMd.match(/^#\s+(.+)$/m)?.[1] ?? "Improvement brief").trim();

        const { data: existingSkill } = await admin
          .from("skills").select("version")
          .eq("recording_id", recording_id).eq("kind", "skill")
          .order("version", { ascending: false }).limit(1);
        const { data: existingImprovement } = await admin
          .from("skills").select("version")
          .eq("recording_id", recording_id).eq("kind", "improvement")
          .order("version", { ascending: false }).limit(1);
        const skillVersion       = ((existingSkill?.[0]?.version as number | undefined) ?? 0) + 1;
        const improvementVersion = ((existingImprovement?.[0]?.version as number | undefined) ?? 0) + 1;

        const inserts = [
          { recording_id, user_id: user.id, version: skillVersion,       title: skillTitle,       body_md: skillMd,       kind: "skill"       as const, prompt_used: SYSTEM },
          { recording_id, user_id: user.id, version: improvementVersion, title: improvementTitle, body_md: improvementMd, kind: "improvement" as const, prompt_used: IMPROVEMENT_SYSTEM },
        ];
        const { data: inserted, error: insErr } = await admin.from("skills").insert(inserts).select("*");
        if (insErr) { await send({ type: "error", message: insErr.message }); return; }

        const primary = (inserted ?? []).find((r: { kind?: string }) =>
          rec.mode === "improvement" ? r.kind === "improvement" : r.kind === "skill"
        ) ?? (inserted ?? [])[0];

        if (!rec.title && primary?.title) {
          await admin.from("recordings").update({ title: primary.title }).eq("id", recording_id);
        }

        await send({ type: "done", ...primary, all: inserted });
      } catch (err) {
        console.error("[generate-skill]", err);
        await send({ type: "error", message: String((err as Error).message) });
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        ...corsHeaders(),
      },
    });
  } catch (err) {
    console.error("[generate-skill]", err);
    return json({ error: String((err as Error).message) }, 500);
  }
});

// Heuristic: do click events carry enough text signal that an LLM can
// reason about the workflow without screenshots? "Strong" = at least 70%
// of click events have a non-empty visibleText OR a CSS selector that
// references something semantic (id/data-test/aria-label). Falls back
// to including images when in doubt.
function eventsHaveStrongTextSignal(
  events: Array<{ kind: string; data: Record<string, unknown> }>,
): boolean {
  const clicks = events.filter((e) => e.kind === "click");
  if (clicks.length < 3) return false; // tiny recording, attach images for context
  let strong = 0;
  for (const e of clicks) {
    const tgt = (e.data?.target as { selector?: string; visibleText?: string } | undefined);
    const text = tgt?.visibleText?.trim() ?? "";
    const sel = tgt?.selector ?? "";
    const semantic = /\[(data-test|aria-label|id)=|#[a-z]/i.test(sel);
    if (text.length > 1 || semantic) strong++;
  }
  return strong / clicks.length >= 0.7;
}

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
  // Compress for the prompt — collapse consecutive character keystrokes so the
  // LLM sees "[typed 12 chars]" rather than 12 individual keydown lines.
  const lines: string[] = [];
  let typingCount = 0;
  let typingStartT = 0;

  const flushTyping = () => {
    if (typingCount > 0) {
      lines.push(`${typingStartT}s [typed ${typingCount} chars]`);
      typingCount = 0;
    }
  };

  for (const e of events) {
    if (e.kind === "scroll") continue;
    const t = Math.round(e.ts_ms / 1000);
    const ts = `${t}s`;

    if (e.kind === "keydown") {
      const key = String((e.data as Record<string, unknown>).key ?? "");
      const mods = (e.data as { modifiers?: { alt: boolean; ctrl: boolean; meta: boolean } }).modifiers;
      const hasModifier = mods && (mods.alt || mods.ctrl || mods.meta);
      const isSpecial = key.length > 1; // "Enter", "Tab", "Escape", etc.
      if (!hasModifier && !isSpecial) {
        if (typingCount === 0) typingStartT = t;
        typingCount++;
        continue;
      }
      flushTyping();
      lines.push(`${ts} keydown ${key}${hasModifier ? ` [mod]` : ""}`);
    } else if (e.kind === "click") {
      flushTyping();
      const tgt = (e.data?.target as { strategy: string; selector: string; visibleText?: string } | undefined);
      lines.push(`${ts} click ${tgt?.visibleText || tgt?.selector || "?"}`);
    } else if (e.kind === "paste") {
      flushTyping();
      lines.push(`${ts} paste "${((e.data as Record<string, unknown>).content_snippet as string) ?? ""}"`);
    } else if (e.kind === "navigation") {
      flushTyping();
      lines.push(`${ts} navigate -> ${truncateUrl(String((e.data as Record<string, unknown>).to_url ?? ""))}`);
    } else if (e.kind === "tab_switch") {
      flushTyping();
      lines.push(`${ts} tab_switch -> ${truncateUrl(String((e.data as Record<string, unknown>).to_tab_url ?? ""))}`);
    } else if (e.kind === "select_change") {
      flushTyping();
      lines.push(`${ts} select "${(e.data as Record<string, unknown>).selected_text}"`);
    } else if (e.kind === "checkbox_change") {
      const d = e.data as Record<string, unknown>;
      lines.push(`${ts} ${d.checked ? "checked" : "unchecked"} ${(d.target as { visibleText?: string } | undefined)?.visibleText ?? String(d.value ?? "")}`);
    } else if (e.kind === "form_fill") {
      flushTyping();
      const d = e.data as Record<string, unknown>;
      const label = (d.field as { selector?: string; visibleText?: string } | undefined)?.visibleText
        ?? (d.field as { selector?: string } | undefined)?.selector ?? "field";
      lines.push(`${ts} fill "${label}" = "${String(d.value ?? "").slice(0, 60)}"`);
    } else {
      flushTyping();
      lines.push(`${ts} ${e.kind}`);
    }
    if (lines.length > 200) {
      lines.push("…(truncated for prompt)");
      break;
    }
  }
  flushTyping();
  return lines.join("\n");
}

function truncateUrl(url: string): string {
  if (!url) return "?";
  try {
    const u = new URL(url);
    const path = u.pathname.length > 48 ? u.pathname.slice(0, 45) + "…" : u.pathname;
    return `${u.hostname}${path}`;
  } catch {
    return url.length > 80 ? url.slice(0, 77) + "…" : url;
  }
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
