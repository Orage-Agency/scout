// /transcribe — download audio from Storage, send to Claude with a transcription
// prompt, store JSON segments in recordings.transcript. Triggered by the service
// worker after audio upload. Per §10.4.1.

import { callLLM, MODEL_TRANSCRIBE } from "../_shared/llm.ts";
import { adminClient, corsHeaders, verifyAuthUser } from "../_shared/supabase.ts";

const SYSTEM = `Transcribe the provided audio recording. Return JSON only with this exact shape:
{"segments":[{"start_ms": <int>, "end_ms": <int>, "text": "..."}]}
Use natural sentence breaks for segments. No preamble, no markdown.`;

interface TranscribeReq {
  recording_id: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  try {
    const user = await verifyAuthUser(req.headers.get("authorization"));
    if (!user) return json({ error: "unauthorized" }, 401);

    const { recording_id } = (await req.json()) as TranscribeReq;
    if (!recording_id) return json({ error: "missing recording_id" }, 400);

    const admin = adminClient();
    const { data: rec, error: recErr } = await admin
      .from("recordings")
      .select("*")
      .eq("id", recording_id)
      .eq("user_id", user.id)
      .single();
    if (recErr || !rec) return json({ error: "recording_not_found" }, 404);
    if (!rec.audio_path) {
      // No audio (mic was denied) — mark ready immediately with empty transcript.
      await admin
        .from("recordings")
        .update({ transcript: { segments: [] }, status: "ready" })
        .eq("id", recording_id);
      return json({ ok: true, segments: 0 });
    }

    const { data: blob, error: dlErr } = await admin.storage.from("audio").download(rec.audio_path);
    if (dlErr || !blob) return json({ error: "audio_download_failed", detail: dlErr?.message }, 500);

    // Convert to base64 for the Anthropic API (audio uses document blocks
    // with audio/* media type at this writing).
    const ab = await blob.arrayBuffer();
    const b64 = bufToBase64(new Uint8Array(ab));
    const mime = blob.type || "audio/webm";

    const text = await callLLM({
      model: MODEL_TRANSCRIBE,
      max_tokens: 8000,
      system: SYSTEM,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: mime, data: b64 } },
            { type: "text", text: "Transcribe the audio. JSON only." },
          ],
        },
      ],
    }).catch((e) => {
      console.warn("[transcribe] llm failed", e);
      return "";
    });

    let segments: Array<{ start_ms: number; end_ms: number; text: string }> = [];
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]);
        if (Array.isArray(parsed.segments)) segments = parsed.segments;
      } catch {
        /* keep empty */
      }
    }

    await admin
      .from("recordings")
      .update({ transcript: { segments }, status: "ready" })
      .eq("id", recording_id);

    return json({ ok: true, segments: segments.length });
  } catch (err) {
    console.error("[transcribe]", err);
    return json({ error: String((err as Error).message) }, 500);
  }
});

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
