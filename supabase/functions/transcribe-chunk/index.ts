// /transcribe-chunk — transcribe a short (≤5 s) audio chunk for live coaching.
// Called by the service worker every 5 s while recording with mic enabled.
// Returns { text } — plain transcribed text, no JSON segments.

import { callLLM } from "../_shared/llm.ts";
import { corsHeaders, verifyAuthUser } from "../_shared/supabase.ts";

// Gemini 2.0 Flash handles audio natively and is fast enough for 5-s cadence.
// Override via LLM_MODEL_TRANSCRIBE_CHUNK secret if needed.
const MODEL = Deno.env.get("LLM_MODEL_TRANSCRIBE_CHUNK") ?? "google/gemini-2.0-flash-001";

const SYSTEM = `Transcribe this short audio clip verbatim. Return only the transcribed text with no JSON, markdown, or explanation. If the clip is silent or contains no intelligible speech, return an empty string.`;

interface TranscribeChunkReq {
  audio_base64: string;
  mime_type: string;
  recording_id: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  const reqId = crypto.randomUUID().slice(0, 8);
  const t0 = Date.now();
  try {
    const user = await verifyAuthUser(req.headers.get("authorization"));
    if (!user) { console.warn(`[transcribe-chunk ${reqId}] unauthorized`); return json({ error: "unauthorized" }, 401); }

    let body: TranscribeChunkReq;
    try { body = (await req.json()) as TranscribeChunkReq; }
    catch { return json({ error: "invalid_json" }, 400); }
    if (!body.audio_base64 || !body.mime_type || !body.recording_id) {
      return json({ error: "missing fields" }, 400);
    }

    const text = await callLLM({
      model: MODEL,
      max_tokens: 500,
      system: SYSTEM,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: body.mime_type, data: body.audio_base64 },
            },
            { type: "text", text: "Transcribe the audio." },
          ],
        },
      ],
    }).catch((e) => {
      console.warn("[transcribe-chunk] llm failed", e);
      return "";
    });

    console.log(`[transcribe-chunk ${reqId}] done chars=${text.trim().length} ms=${Date.now() - t0}`);
    return json({ text: text.trim() });
  } catch (err) {
    console.error(`[transcribe-chunk ${reqId}] error ms=${Date.now() - t0}`, err);
    return json({ error: String((err as Error).message) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}
