// /run-skill — execute a SKILL.md workflow via Claude.
// Fetches the skill from DB, asks Claude to parse the Faster path section
// into executable steps, runs each HTTP step directly, and streams progress
// back as SSE. Results stored in skill_runs.

import { callLLMStream } from "../_shared/llm.ts";
import { adminClient, corsHeaders, verifyAuthUser } from "../_shared/supabase.ts";

const PLANNER_SYSTEM = `You are a workflow execution engine. You receive a SKILL.md file and a map of input values.

Your task: analyze the workflow and produce a JSON execution plan by focusing on the "Faster path" section.

Rules:
1. Read the ## Faster path section. Each bullet that describes an HTTP call becomes a step with type "http".
2. Substitute every {placeholder} with the matching value from the inputs map. If a placeholder has no value, leave it as-is.
3. Bullets that mention CLI commands, MCP tools, or manual UI steps become type "manual" — do not invent HTTP equivalents.
4. Do NOT fabricate endpoints or add steps not in the SKILL.md.
5. Maximum 20 steps total.

Output ONLY a JSON object — no preamble, no markdown fences:
{
  "steps": [
    {
      "n": 1,
      "description": "one line describing what this step does",
      "type": "http" | "manual",
      "http": {
        "method": "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        "url": "https://...",
        "headers": { "Authorization": "Bearer sk-..." },
        "body": { }
      },
      "note": "optional reason — only needed for manual steps"
    }
  ]
}

For type "manual", omit the "http" key entirely.
For type "http" with method GET, set "body" to null.`;

interface RunReq {
  skill_id: string;
  inputs?: Record<string, string>;
}

interface PlanStep {
  n: number;
  description: string;
  type: "http" | "manual";
  http?: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  note?: string;
}

// Disallow calls that look like internal infra — we only want real external APIs.
function isSafeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h === "127.0.0.1" || h.endsWith(".local")) return false;
    // Block calls back to Supabase itself to prevent privilege escalation.
    if (h.endsWith(".supabase.co")) return false;
    return true;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const reqId = crypto.randomUUID().slice(0, 8);
  const t0 = Date.now();

  try {
    const user = await verifyAuthUser(req.headers.get("authorization"));
    if (!user) {
      console.warn(`[run-skill ${reqId}] unauthorized`);
      return json({ error: "unauthorized" }, 401);
    }
    console.log(`[run-skill ${reqId}] user=${user.id}`);

    let skill_id: string;
    let inputs: Record<string, string> = {};
    try {
      ({ skill_id, inputs = {} } = (await req.json()) as RunReq);
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (!skill_id) return json({ error: "missing skill_id" }, 400);

    const admin = adminClient();
    const { data: skill, error: skillErr } = await admin
      .from("skills")
      .select("id, body_md, title, recording_id")
      .eq("id", skill_id)
      .eq("user_id", user.id)
      .single();
    if (skillErr || !skill) {
      console.warn(`[run-skill ${reqId}] skill_not_found id=${skill_id}`);
      return json({ error: "skill_not_found" }, 404);
    }

    // Create a run record so the popup can show history even if it disconnects.
    const { data: run } = await admin
      .from("skill_runs")
      .insert({ skill_id, user_id: user.id, inputs, status: "running" })
      .select("id")
      .single();
    const runId: string | undefined = (run as { id?: string } | null)?.id;

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();

    const send = async (data: unknown): Promise<void> => {
      try {
        await writer.write(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
      } catch { /* client disconnected */ }
    };

    (async () => {
      try {
        await send({ type: "status", message: "Analysing skill with Claude…" });

        // Ask Claude to parse the Faster path into an executable plan.
        const userMsg = `SKILL.md:\n\`\`\`\n${(skill as { body_md: string }).body_md}\n\`\`\`\n\nInputs: ${JSON.stringify(inputs)}`;
        let planText = "";
        for await (const chunk of callLLMStream({
          model: "claude-sonnet-4-6",
          max_tokens: 2000,
          system: PLANNER_SYSTEM,
          temperature: 0,
          messages: [{ role: "user", content: userMsg }],
        })) {
          planText += chunk;
        }

        let plan: { steps: PlanStep[] } | null = null;
        const m = planText.match(/\{[\s\S]*\}/);
        if (m) {
          try { plan = JSON.parse(m[0]) as { steps: PlanStep[] }; } catch { /* malformed */ }
        }

        if (!plan?.steps?.length) {
          console.error(`[run-skill ${reqId}] no_plan planText=${planText.slice(0, 200)}`);
          if (runId) await admin.from("skill_runs").update({ status: "failed", error: "no_plan" }).eq("id", runId);
          await send({ type: "error", message: "Claude could not produce an execution plan. The skill may have no Faster path steps." });
          return;
        }

        await send({ type: "plan", steps: plan.steps });
        console.log(`[run-skill ${reqId}] plan_steps=${plan.steps.length}`);

        // Execute each step.
        const results: Array<{ n: number; status: string; output?: unknown; error?: string }> = [];

        for (const step of plan.steps) {
          await send({ type: "step_start", n: step.n, description: step.description, step_type: step.type });

          if (step.type === "manual") {
            await send({ type: "step_done", n: step.n, status: "manual", note: step.note ?? "Requires manual action in the browser." });
            results.push({ n: step.n, status: "manual" });
            continue;
          }

          if (step.type === "http" && step.http) {
            const { method, url, headers = {}, body } = step.http;

            if (!isSafeUrl(url)) {
              const errMsg = `Blocked URL: ${url}`;
              console.warn(`[run-skill ${reqId}] blocked_url step=${step.n} url=${url}`);
              await send({ type: "step_done", n: step.n, status: "blocked", error: errMsg });
              results.push({ n: step.n, status: "blocked", error: errMsg });
              continue;
            }

            try {
              const fetchRes = await fetch(url, {
                method,
                headers: { "content-type": "application/json", ...headers },
                ...(body != null ? { body: JSON.stringify(body) } : {}),
              });
              const text = await fetchRes.text();
              let output: unknown = text;
              try { output = JSON.parse(text); } catch { /* keep as text */ }
              const status = fetchRes.ok ? "ok" : "error";
              const outputSafe = typeof output === "object" ? output : String(text).slice(0, 500);
              console.log(`[run-skill ${reqId}] step=${step.n} http_status=${fetchRes.status} ok=${fetchRes.ok}`);
              await send({ type: "step_done", n: step.n, status, http_status: fetchRes.status, output: outputSafe });
              results.push({ n: step.n, status, output: outputSafe });
            } catch (e) {
              const errMsg = (e as Error).message;
              console.error(`[run-skill ${reqId}] step=${step.n} fetch_error`, e);
              await send({ type: "step_done", n: step.n, status: "error", error: errMsg });
              results.push({ n: step.n, status: "error", error: errMsg });
            }
            continue;
          }
        }

        const allOk = results.every((r) => r.status === "ok" || r.status === "manual");
        const finalStatus = allOk ? "completed" : "failed";
        if (runId) {
          await admin.from("skill_runs").update({ status: finalStatus, steps: results }).eq("id", runId);
        }
        console.log(`[run-skill ${reqId}] done status=${finalStatus} steps=${results.length} ms=${Date.now() - t0}`);
        await send({ type: "done", run_id: runId, status: finalStatus, results });
      } catch (err) {
        console.error(`[run-skill ${reqId}] stream_error ms=${Date.now() - t0}`, err);
        if (runId) {
          await admin.from("skill_runs")
            .update({ status: "failed", error: String((err as Error).message) })
            .eq("id", runId);
        }
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
    console.error(`[run-skill ${reqId}] fatal ms=${Date.now() - t0}`, err);
    return json({ error: String((err as Error).message) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}
