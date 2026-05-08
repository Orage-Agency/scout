// Single LLM client used by all three Edge Functions. Calls the Anthropic
// Messages API directly when ANTHROPIC_API_KEY is set; falls back to
// OpenRouter (OpenAI-compat) otherwise. Per-task model is configurable via
// env so we can split coach/transcribe/skill across cheap vs. capable models
// without redeploying code.
//
// Set once with:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-api03-...
//   (or) supabase secrets set OPENROUTER_API_KEY=sk-or-v1-...
//
// Model env overrides (defaults below). Model ids are Anthropic-native
// (claude-sonnet-4-6, claude-haiku-4-5, etc). The OpenRouter path
// auto-prefixes "anthropic/" and converts dots to dashes.

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_MODEL = Deno.env.get("LLM_MODEL") ?? "claude-sonnet-4-6";

export const MODEL_COACH = Deno.env.get("LLM_MODEL_COACH") ?? "claude-haiku-4-5";
export const MODEL_TRANSCRIBE = Deno.env.get("LLM_MODEL_TRANSCRIBE") ?? "claude-sonnet-4-6";
export const MODEL_SKILL = Deno.env.get("LLM_MODEL_SKILL") ?? "claude-sonnet-4-6";

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

export async function callLLM(req: LLMRequest): Promise<string> {
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (anthropicKey) return callAnthropic(req, anthropicKey);
  const openRouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (openRouterKey) return callOpenRouter(req, openRouterKey);
  throw new Error("No LLM key configured (ANTHROPIC_API_KEY or OPENROUTER_API_KEY)");
}

// ---- Anthropic direct ----

async function callAnthropic(req: LLMRequest, key: string): Promise<string> {
  const body = {
    model: anthropicModelId(req.model ?? DEFAULT_MODEL),
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    system: req.system,
    messages: req.messages.map(toAnthropicMessage),
  };
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Concatenate any text blocks in the response.
  const blocks = (data.content as Array<{ type: string; text?: string }> | undefined) ?? [];
  return blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}

function toAnthropicMessage(m: LLMMessage): Record<string, unknown> {
  if (typeof m.content === "string") return { role: m.role, content: m.content };
  // deno-lint-ignore no-explicit-any
  const parts: any[] = [];
  for (const b of m.content) {
    if (b.type === "text") {
      parts.push({ type: "text", text: b.text ?? "" });
    } else if ((b.type === "image" || b.type === "document") && b.source) {
      // Anthropic expects { type: "image", source: { type: "base64", media_type, data } }
      // or { type: "image", source: { type: "url", url } }. Pass through as-is
      // since our ContentBlock.source already matches that shape.
      parts.push({ type: "image", source: b.source });
    }
  }
  return { role: m.role, content: parts };
}

// Anthropic uses dashes everywhere ("claude-sonnet-4-6"). Strip OpenRouter
// "anthropic/" prefix and convert dotted minor versions ("4.6" → "4-6").
function anthropicModelId(id: string): string {
  return id.replace(/^anthropic\//, "").replace(/(\d)\.(\d)/g, "$1-$2");
}

// ---- OpenRouter (legacy fallback) ----

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

async function callOpenRouter(req: LLMRequest, key: string): Promise<string> {
  const body = JSON.stringify({
    model: openRouterModelId(req.model ?? DEFAULT_MODEL),
    messages: toOpenAIMessages(req),
    max_tokens: req.max_tokens,
    temperature: req.temperature,
  });
  const res = await fetch(OPENROUTER_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${key}`,
      "HTTP-Referer": "https://github.com/Orage-Agency/scout",
      "X-Title": "Scout",
    },
    body,
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// OpenRouter expects "anthropic/claude-sonnet-4.6" (dot-version, namespaced).
// Convert from Anthropic-native "claude-sonnet-4-6" if needed.
function openRouterModelId(id: string): string {
  if (id.includes("/")) return id;  // already namespaced
  // Heuristic: claude-* → anthropic/<id-with-dot>. Convert last two
  // hyphenated digits back to dotted form (sonnet-4-6 → sonnet-4.6).
  const dotted = id.replace(/(\d)-(\d)$/, "$1.$2");
  if (id.startsWith("claude-")) return `anthropic/${dotted}`;
  return dotted;
}
