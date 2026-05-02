# Blockers

Anything that stopped the autonomous build. Each entry: what, what was tried, what's needed to unblock.

---

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
