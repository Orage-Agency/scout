# Scout v1 — Resume Instructions

> Read this first when picking up this build in a new session. Updated 2026-05-02 after the resume run.

## Status snapshot

- ✅ **Phase 1** scaffold + deps
- ✅ **Phase 2** capture engine
- ✅ **Phase 3** schema + storage + popup UI + **build clean** (icons generated, `pnpm build` succeeds)
- ✅ **Phase 4** coach Edge Function **deployed**
- ✅ **Phase 5** transcribe + generate-skill Edge Functions **deployed**
- 🟡 **Phase 6** local repo committed + tagged v0.1.0; remote `Orage-Agency/scout` (private) created; **push pending** (creds prompt)

## What's actually deployed

- **Supabase project** ref `wmicxsafqbixedpjhchc` — schema applied, three private buckets live (screenshots/audio/skills), three Edge Functions deployed: `coach`, `transcribe`, `generate-skill`.
- **Supabase PAT** for CLI: `sbp_665046f50d5b1954a25c95ecb10e4d2566326dc9` (token name `scout-cli-deploy` in supabase.com/dashboard/account/tokens). Set as `$env:SUPABASE_ACCESS_TOKEN` to skip `supabase login` next time.
- **Supabase CLI binary** at `C:\Users\georg\scout\node_modules\supabase\bin\supabase.exe` (v2.98.0). Not on PATH; invoke directly.
- **Local git** initialized, two commits, tag `v0.1.0`. Remote `origin` → `https://github.com/Orage-Agency/scout.git` (private, owned by `Orage-Agency`).
- **Local git identity** set repo-locally: `George Moffat <georgemoffat@orage.agency>`.

## Three things still needed (all need you, none need Claude)

### 1. Set the Anthropic API key as an Edge Function secret

Functions are deployed but will 500 until this is set. From any PowerShell:

```powershell
$env:SUPABASE_ACCESS_TOKEN = "sbp_665046f50d5b1954a25c95ecb10e4d2566326dc9"
& "C:\Users\georg\scout\node_modules\supabase\bin\supabase.exe" secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref wmicxsafqbixedpjhchc
```

### 2. Push the local commits to GitHub

The repo exists; the push just needs you to click through the GCM browser prompt once:

```powershell
cd C:\Users\georg\scout
git push -u origin main
git push origin v0.1.0
```

Browser pops, you approve, done.

### 3. Smoke test in Chrome

```
chrome://extensions → Developer mode → Load unpacked → C:\Users\georg\scout\apps\extension\dist
```

Click the extension icon → magic-link sign-in with a real email → click Record on any page → do a 30s workflow → Stop → wait for status `ready` → Generate Skill.

## Files of interest

- `BUILD_LOG.md` — chronological log including the v0.2 retro paragraph at the bottom
- `BLOCKERS.md` — what's resolved + what's still open
- `DECISIONS.md` — non-obvious choices and reasoning
- `README.md` — full setup and user-facing docs
- `docs/SKILL_TEMPLATE.md` — reference output format

## Open questions / TODOs from v0.1

- Region: project was created without explicit `us-east-1`; recreate via Management API if region matters.
- `transcribe`: passes audio as a Claude `document` block — confirm the API accepts `audio/webm` for that block at deploy. Swap to a Whisper proxy if not.
- Per-recording `title` is never set — popup shows "Untitled recording". Nice v0.2: ask Claude for a 3-word title at generation time and patch `recordings.title`.
