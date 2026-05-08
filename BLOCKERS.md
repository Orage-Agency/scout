# Blockers

Anything that stopped the autonomous build. Each entry: what, what was tried, what's needed to unblock.

---

## CRITICAL — Supabase PAT expired (2026-05-08)

The PAT `sbp_665046f50d5b1954a25c95ecb10e4d2566326dc9` has expired. Edge function
improvements accumulated since v0.1.5 (form_fill, copy content, context text,
smarter truncation, wait-for clauses, coach copy handling) are in git but NOT yet
deployed to `wmicxsafqbixedpjhchc`.

**To fix:**
1. Go to https://supabase.com/dashboard/account/tokens
2. Create a new PAT named `scout-cli-deploy`
3. In terminal: `$env:SUPABASE_ACCESS_TOKEN = "<new_pat>"`
4. Run: `powershell -ExecutionPolicy Bypass -File scripts\deploy-edge-functions.ps1`

The deploy script handles all three functions (coach, transcribe, generate-skill)
in one shot and exits on first failure.

---

## Open follow-ups (from 2026-05-07 v0.1.5 session)

### Live transcription

The coach currently calls `/coach` with `transcript_tail: ""` because we only transcribe at recording stop. Live transcription would make the coach dramatically smarter mid-recording.

Approach: stop+restart the offscreen MediaRecorder every 5s (each window becomes an independently decodable webm). New edge function `transcribe-chunk` takes the chunk, transcribes via Gemini, returns text. Service worker maintains an in-memory rolling `liveTranscript` (~1500 chars) and passes it as `transcript_tail` to `/coach`.

Why deferred: getting MediaRecorder framing right (each window must include the EBML header) needs careful testing across Chrome versions and audio devices — not worth a half-baked first cut.

Files to touch: `apps/extension/src/offscreen/index.ts`, `apps/extension/src/background/index.ts`, new `supabase/functions/transcribe-chunk/index.ts`. `coach/index.ts` already accepts `transcript_tail`.

### OCR-based screenshot redaction

Visible on-screen PII gets captured raw today. Tesseract.js client-side (~3MB bundle) or a server-side Edge Function — privacy posture for guest-mode customer recordings depends on this being solved before any non-Orage testers touch real customer surfaces.

---

## RESOLVED in 2026-05-02 resume session
- B1 (Supabase): PAT minted via cached browser session, CLI linked, all three Edge Functions deployed.
- B2 (`gh`): unused — created the GitHub repo via the dashboard, pushed via short-lived PAT minted after sudo-mode email-verify.
- B3 (LLM provider key): switched architecture to OpenRouter for model flexibility; `OPENROUTER_API_KEY` set as a Supabase secret. All three functions live and verified.
- B4 (icon PNGs): generated via System.Drawing PowerShell. `pnpm build` clean.
- B5 (`git push`): pushed `main` + `v0.1.0` after minting a short-lived `repo`-scoped PAT through the cached Playwright session, then revoked it.

## Still open (genuinely needs the user)
- **End-to-end smoke test** — `chrome.developerPrivate.loadUnpacked()` triggers a native OS folder picker that Playwright cannot drive. The user must open `chrome://extensions`, toggle Developer mode, click Load unpacked, and pick `C:\Users\georg\scout\apps\extension\dist`. Confirmed during this session: dev mode toggle works programmatically; picker does not. No further autonomous bypass available short of re-launching Chrome with `--load-extension=` (which Playwright MCP doesn't expose).

---

## Original blockers (kept for history)

## B1 — Supabase MCP not connected; cannot auto-provision the Supabase project

**What:** Operating Rule 1.3 (Phase 1 step 1) says "Claude Code creates the Supabase project itself in Phase 1 using the Supabase MCP (already connected and authenticated)." That MCP is not present in this environment.

**What was tried:**
- `ToolSearch` for "supabase" — no MCP tools surface.
- Checked env for `SUPABASE_ACCESS_TOKEN` (would let me hit the Management API directly via `fetch`) — not set.

**Result:** Codebase is fully built and migration SQL is ready. The user must, before running the extension:
1. Create a Supabase project (region us-east-1, name `scout`) at https://supabase.com/dashboard.
2. Copy `Project URL`, `anon key`, `service_role key` into `.env`.
3. Also fill `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (same project URL, anon key).
4. From repo root: `pnpm exec supabase login` (interactive), then `pnpm exec supabase link --project-ref <ref>`, then `pnpm exec supabase db push`.
5. In the Supabase dashboard, create three Storage buckets (private): `screenshots`, `audio`, `skills`.
6. `pnpm exec supabase secrets set ANTHROPIC_API_KEY=<key>`.
7. `pnpm exec supabase functions deploy coach && pnpm exec supabase functions deploy transcribe && pnpm exec supabase functions deploy generate-skill`.

**To unblock fully autonomously next time:** ensure the Supabase MCP server is configured in the Claude Code settings before the run starts, or pre-set `SUPABASE_ACCESS_TOKEN` in the shell.

---

## B2 — `gh` CLI was not installed at start

**What:** Operating Rule 1.4 says `gh` CLI is authenticated. `gh` was not present on PATH.

**What was tried:** `winget install --id GitHub.cli` started in the background. If it succeeds before the build ends, the GitHub repo is created automatically. If not, the local repo is committed and the user runs `gh repo create scout --private --source=. --remote=origin --push` themselves.

**To unblock fully autonomously next time:** pre-install `gh` and run `gh auth login` before starting Claude Code.

---

## B3 — `ANTHROPIC_API_KEY` not in shell env

**What:** Operating Rule 1.3 says the key flows in via Claude Code's terminal auth and gets reused as a Supabase Edge Function secret. No environment variable is exposed to Bash/PowerShell.

**What was tried:** Checked `$env:ANTHROPIC_API_KEY` — not set. The key is only available to Claude Code's own model calls, not to subprocess commands.

**Result:** Edge Function code is written to read `Deno.env.get("ANTHROPIC_API_KEY")`. The user must run `supabase secrets set ANTHROPIC_API_KEY=<their-key>` once before deploying functions. Documented in README and `.env.example`.
