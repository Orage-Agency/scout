# Scout v1 — Resume Instructions

> Read this first when picking up this build in a new session. Updated 2026-05-02 after the OpenRouter pivot.

## Status snapshot

- ✅ **Phase 1** scaffold + deps
- ✅ **Phase 2** capture engine
- ✅ **Phase 3** schema + storage + popup UI + clean build
- ✅ **Phase 4** coach Edge Function deployed
- ✅ **Phase 5** transcribe + generate-skill Edge Functions deployed (now via OpenRouter)
- ✅ **Phase 6** local repo + GitHub remote pushed (`Orage-Agency/scout`, private), `v0.1.0` tag pushed
- 🟡 **Smoke test** — not yet run (requires loading unpacked extension into a Chrome instance the user controls)

## What's deployed

- **Supabase project** ref `wmicxsafqbixedpjhchc` — schema applied, three private buckets (screenshots/audio/skills), three Edge Functions live: `coach`, `transcribe`, `generate-skill`. All three now route through OpenRouter (single `_shared/llm.ts` client).
- **Supabase PAT** for CLI: `sbp_665046f50d5b1954a25c95ecb10e4d2566326dc9` (token name `scout-cli-deploy`). Set as `$env:SUPABASE_ACCESS_TOKEN` to skip `supabase login`.
- **Supabase CLI binary** at `C:\Users\georg\scout\node_modules\supabase\bin\supabase.exe` (v2.98.0). Not on PATH; invoke directly.
- **OpenRouter** key minted under team@orage.agency (key name "Scout"); stored only as Supabase secret `OPENROUTER_API_KEY` and in `.env`.
- **Default models** (override per-task via env without redeploying):
  - `OPENROUTER_MODEL_COACH=anthropic/claude-haiku-4.5` (cheap, 30s loop)
  - `OPENROUTER_MODEL_TRANSCRIBE=google/gemini-2.5-flash` (audio support)
  - `OPENROUTER_MODEL_SKILL=anthropic/claude-opus-4.5` (vision + reasoning)
- **GitHub remote**: `https://github.com/Orage-Agency/scout` (private), `main` + tag `v0.1.0` pushed.
- **Local git identity**: `George Moffat <georgemoffat@orage.agency>` set repo-locally.

## One thing remaining: smoke test

The native folder picker on `chrome://extensions` is OS-level, so this can't be done from Playwright/MCP. Steps:

1. Open `chrome://extensions/` in your everyday Chrome
2. Toggle Developer mode (top-right)
3. Click **Load unpacked** → pick `C:\Users\georg\scout\apps\extension\dist`
4. Click the Scout icon, sign in with magic link
5. Click Record on any page → do a 30s workflow → Stop → wait for status `ready` → Generate Skill

If anything fails, paste the popup's console logs (right-click → Inspect popup) and the failing recording's `id` from Supabase and we'll fix in the next session.

## Files of interest

- `BUILD_LOG.md` — full chronological log including the v0.2 retro
- `BLOCKERS.md` — what was resolved + what's open
- `DECISIONS.md` — non-obvious choices and reasoning (LLM gateway, model choice)
- `README.md` — full setup and user-facing docs
- `docs/SKILL_TEMPLATE.md` — reference output format
- `supabase/functions/_shared/llm.ts` — the OpenRouter client; swap providers here if needed

## Open enhancements (not blockers)

- Per-recording `title` is never set — popup shows "Untitled recording". v0.2: ask Claude for a 3-word title at generation time and patch `recordings.title`.
- Region: project was created in default Americas region; recreate via Management API if `us-east-1` matters.
- Transcribe assumes Gemini accepts `audio/webm` via the `image_url` data-URL pathway. If it doesn't, swap `OPENROUTER_MODEL_TRANSCRIBE` to a different audio-capable model or transcode webm→mp3 in the offscreen document.
