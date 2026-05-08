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
  // Anthropic prompt-cache breakpoint. When set, Anthropic caches the
  // request prefix up to and including this block. Subsequent calls with
  // the same prefix within ~5 minutes pay ~10% of the input-token price.
  cache_control?: { type: "ephemeral" };
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

// Streaming version — yields text deltas as they arrive.
export async function* callLLMStream(req: LLMRequest): AsyncGenerator<string> {
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (anthropicKey) { yield* streamAnthropic(req, anthropicKey); return; }
  const openRouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (openRouterKey) { yield* streamOpenRouter(req, openRouterKey); return; }
  throw new Error("No LLM key configured (ANTHROPIC_API_KEY or OPENROUTER_API_KEY)");
}

async function* streamAnthropic(req: LLMRequest, key: string): AsyncGenerator<string> {
  const systemBlocks = req.system
    ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
    : undefined;
  const body = {
    model: anthropicModelId(req.model ?? DEFAULT_MODEL),
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    system: systemBlocks,
    messages: req.messages.map(toAnthropicMessage),
    stream: true,
  };
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": "prompt-caching-2024-07-31",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6);
      if (raw === "[DONE]") return;
      try {
        const evt = JSON.parse(raw);
        // content_block_delta carries text_delta
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
          yield evt.delta.text as string;
        }
      } catch { /* skip */ }
    }
  }
}

async function* streamOpenRouter(req: LLMRequest, key: string): AsyncGenerator<string> {
  const body = JSON.stringify({
    model: openRouterModelId(req.model ?? DEFAULT_MODEL),
    messages: toOpenAIMessages(req),
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    stream: true,
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
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6);
      if (raw === "[DONE]") return;
      try {
        const evt = JSON.parse(raw);
        const delta = evt.choices?.[0]?.delta?.content ?? "";
        if (delta) yield delta as string;
      } catch { /* skip */ }
    }
  }
}

// ---- Anthropic direct ----

async function callAnthropic(req: LLMRequest, key: string): Promise<string> {
  // System prompt is wrapped as a content block so we can mark it cacheable.
  // The Messages API accepts both `system: string` and `system: ContentBlock[]`;
  // when caching is enabled we always go with the array form.
  const systemBlocks = req.system
    ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
    : undefined;
  const body = {
    model: anthropicModelId(req.model ?? DEFAULT_MODEL),
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    system: systemBlocks,
    messages: req.messages.map(toAnthropicMessage),
  };
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": "prompt-caching-2024-07-31",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Surface cache stats so cost-tracing is easy: usage.cache_creation_input_tokens
  // (paid 1.25× this once, then 0.1× on subsequent hits within 5 min) and
  // cache_read_input_tokens (already paid 1.25× upstream, charged 0.1× now).
  const u = data.usage as
    | { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
    | undefined;
  if (u) {
    console.log(
      `[llm] in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0}`,
    );
  }
  const blocks = (data.content as Array<{ type: string; text?: string }> | undefined) ?? [];
  return blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}

function toAnthropicMessage(m: LLMMessage): Record<string, unknown> {
  if (typeof m.content === "string") return { role: m.role, content: m.content };
  // deno-lint-ignore no-explicit-any
  const parts: any[] = [];
  for (const b of m.content) {
    if (b.type === "text") {
      const part: Record<string, unknown> = { type: "text", text: b.text ?? "" };
      if (b.cache_control) part.cache_control = b.cache_control;
      parts.push(part);
    } else if ((b.type === "image" || b.type === "document") && b.source) {
      const part: Record<string, unknown> = { type: "image", source: b.source };
      if (b.cache_control) part.cache_control = b.cache_control;
      parts.push(part);
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
