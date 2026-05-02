// Single LLM client used by all three Edge Functions. Calls OpenRouter
// (OpenAI-compatible chat completions). Per-task model is configurable via
// env so we can split coach/transcribe/skill across cheap vs. capable models
// without redeploying code.
//
// Set once with:
//   supabase secrets set OPENROUTER_API_KEY=sk-or-v1-...
//
// Optional overrides (all have defaults):
//   OPENROUTER_MODEL_COACH       (cheap, fast — coach loop fires every 30s)
//   OPENROUTER_MODEL_TRANSCRIBE  (must accept audio input)
//   OPENROUTER_MODEL_SKILL       (vision-capable for screenshots)
//   OPENROUTER_MODEL             (fallback default for any of the above)

const API = "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_MODEL = Deno.env.get("OPENROUTER_MODEL") ?? "anthropic/claude-sonnet-4.5";

export const MODEL_COACH = Deno.env.get("OPENROUTER_MODEL_COACH") ?? "anthropic/claude-haiku-4.5";
export const MODEL_TRANSCRIBE = Deno.env.get("OPENROUTER_MODEL_TRANSCRIBE") ?? "google/gemini-2.5-flash";
export const MODEL_SKILL = Deno.env.get("OPENROUTER_MODEL_SKILL") ?? "anthropic/claude-opus-4.5";

export interface ContentBlock {
  type: "text" | "image" | "document";
  text?: string;
  source?:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}

export interface LLMMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface LLMRequest {
  model?: string;
  max_tokens: number;
  system?: string;
  messages: LLMMessage[];
  temperature?: number;
}

// deno-lint-ignore no-explicit-any
type OpenAIPart = any;

function toOpenAIMessages(req: LLMRequest): OpenAIPart[] {
  const out: OpenAIPart[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const parts: OpenAIPart[] = [];
    for (const b of m.content) {
      if (b.type === "text") {
        parts.push({ type: "text", text: b.text ?? "" });
      } else if ((b.type === "image" || b.type === "document") && b.source) {
        // Both images and audio go through image_url with a data URL — this
        // is how OpenRouter's OpenAI-compat layer routes binary inputs to the
        // underlying model (Gemini accepts audio/* MIME types this way).
        const url = b.source.type === "base64"
          ? `data:${b.source.media_type};base64,${b.source.data}`
          : b.source.url;
        parts.push({ type: "image_url", image_url: { url } });
      }
    }
    out.push({ role: m.role, content: parts });
  }
  return out;
}

export async function callLLM(req: LLMRequest): Promise<string> {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("OPENROUTER_API_KEY not set");

  const body = JSON.stringify({
    model: req.model ?? DEFAULT_MODEL,
    messages: toOpenAIMessages(req),
    max_tokens: req.max_tokens,
    temperature: req.temperature,
  });

  const res = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${key}`,
      "HTTP-Referer": "https://github.com/Orage-Agency/scout",
      "X-Title": "Scout",
    },
    body,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${txt}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}
