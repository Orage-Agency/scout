// /generate-skill — fetch events + transcript + sampled screenshots, ask Claude
// to produce a SKILL.md, persist it. Per §10.

import { callLLM, MODEL_SKILL } from "../_shared/llm.ts";
import { adminClient, corsHeaders, userClient } from "../_shared/supabase.ts";

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

## Steps
<Numbered list. Each step:
 - Describes the action in plain English (NOT 'click pixel 423,180')
 - Names the target element by visible text or aria-label
 - Notes any decision logic (e.g., 'if total > $500, also check X')
 - References screenshot filenames where helpful: ![](step_3.png)>

## Decision rules
<Captured from the user's narration and the coach's asks. Explicit
rules that aren't obvious from the screen alone.>

## Edge cases
<Things that might go wrong and how the user handled them, if seen.
If not seen, write 'None observed.'>

## Done when
<How the agent knows the task succeeded.>`;

interface GenReq {
  recording_id: string;
  extra?: string;
}

const MAX_SCREENSHOTS = 12;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  try {
    const sb = userClient(req.headers.get("authorization"));
    const { data: { user } } = await sb.auth.getUser();
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

    const userPrompt = `Now produce the SKILL.md from these materials.${extra ? `\nExtra guidance from the user: ${extra}` : ""}

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
      max_tokens: 8000,
      system: SYSTEM,
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
        prompt_used: SYSTEM,
      })
      .select("*")
      .single();
    if (insErr) return json({ error: insErr.message }, 500);

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
