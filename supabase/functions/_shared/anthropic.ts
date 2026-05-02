// Tiny Anthropic client used by all three Edge Functions. Reads the key from
// `Deno.env.get("ANTHROPIC_API_KEY")`. Set once with:
//   supabase secrets set ANTHROPIC_API_KEY=...

export const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-opus-4-5";
const API = "https://api.anthropic.com/v1/messages";

export interface ContentBlock {
  type: "text" | "image" | "document";
  // text
  text?: string;
  // image / document
  source?:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ClaudeRequest {
  model?: string;
  max_tokens: number;
  system?: string;
  messages: ClaudeMessage[];
  temperature?: number;
}

export async function callClaude(req: ClaudeRequest): Promise<string> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const body = JSON.stringify({ model: MODEL, ...req });
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Anthropic ${res.status}: ${txt}`);
  }
  const data = await res.json();
  // Concatenate all text blocks.
  const blocks = (data.content ?? []) as ContentBlock[];
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}
