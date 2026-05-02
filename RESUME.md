# Scout v1 — Resume Instructions

> Read this first when picking up this build in a new session. It captures full state as of the last working moment.

## Where we are

**Project root:** `C:\Users\georg\scout`

**Status by phase:**
- ✅ **Phase 1 — Repo & Project Skeleton**: directory tree, `package.json`, `pnpm-workspace.yaml`, `.env.example`, `.env` (with real Supabase creds), `tsconfig.json`, `vite.config.ts`, `tailwind.config.ts`, `postcss.config.js`, `manifest.json`. `pnpm install` completed successfully.
- ✅ **Phase 2 — Capture Engine**: `apps/extension/src/background/index.ts`, `content/index.ts`, `offscreen/index.ts`, plus `lib/{types,supabase,selector,redaction,queue,ids}.ts`. All written.
- 🟡 **Phase 3 — Supabase Wiring**: schema + RLS + storage policies applied to live project. Storage buckets `screenshots`, `audio`, `skills` created. Popup UI fully written including auth, library, recording state, skill panel. **Remaining:** verify build, run end-to-end test in a real browser.
- ⚪ **Phase 4 — Coaching Layer**: Edge Function `supabase/functions/coach/index.ts` written. Service-worker coach loop already wired. **Remaining:** deploy the function, set `ANTHROPIC_API_KEY` secret.
- ⚪ **Phase 5 — Skill Generator**: Edge Functions `supabase/functions/{transcribe,generate-skill}/index.ts` written. Popup side-panel renders SKILL.md. **Remaining:** deploy functions; tune prompts after first real test.
- ⚪ **Phase 6 — Polish, Smoke Test, Ship**: floating control bar in content script, tab-close handling, network-drop queue, Playwright smoke test in `tests/smoke.spec.ts`, README. **Remaining:** generate icons, run smoke test, git push, tag v0.1.0.

## Live Supabase project

- **Project ref:** `wmicxsafqbixedpjhchc`
- **URL:** `https://wmicxsafqbixedpjhchc.supabase.co`
- **Region:** Americas (default — east-1 was not exposed by the new-project form)
- **DB password:** stored in `.env` as `SUPABASE_DB_PASSWORD`
- **Anon + service-role keys:** stored in `.env`
- **Schema applied:** `supabase/migrations/0001_initial.sql` ran successfully via the SQL editor (twice — once to create tables/RLS, once after bucket creation to attach storage policies).
- **Buckets created:** `screenshots`, `audio`, `skills` (all private). Created via Storage REST API with the service-role key.
- **Edge Functions:** code written in `supabase/functions/{coach,transcribe,generate-skill}/index.ts` and `supabase/functions/_shared/{anthropic.ts,supabase.ts}`. **Not yet deployed.** Deploy with:
  ```
  pnpm exec supabase login          # interactive
  pnpm exec supabase link --project-ref wmicxsafqbixedpjhchc
  pnpm exec supabase secrets set ANTHROPIC_API_KEY=<your-key>
  pnpm exec supabase functions deploy coach
  pnpm exec supabase functions deploy transcribe
  pnpm exec supabase functions deploy generate-skill
  ```

## Local environment

- **Node:** 25.9.0
- **pnpm:** 10.33.2
- **git:** 2.53 (repo not yet initialized)
- **gh CLI:** installed via `winget install GitHub.cli` during this session — needs `gh auth login` interactive once after a fresh PowerShell session
- **supabase CLI:** **not yet installed.** Install with `pnpm install -g supabase` or use the project devDep `pnpm exec supabase ...`
- **Playwright MCP:** connected and used to provision the Supabase project + run SQL.

## Where the build broke last

`pnpm build` failed because the icon files don't exist:
```
[crx:manifest-post] ENOENT: Could not load manifest asset "public/icons/icon-16.png".
```
TypeScript compiled clean. Two prior TS errors were fixed (`ids.ts` and an unused import in `background/index.ts`).

## Pick-up steps (in order)

1. **Generate icons.** Easiest path is a tiny PowerShell that fills a square with `#0F172A` and draws a `#DC2626` circle at 16/32/48/128 px. Save under `apps/extension/public/icons/icon-{size}.png`. The interrupted command was:
   ```powershell
   Add-Type -AssemblyName System.Drawing
   foreach ($size in 16,32,48,128) {
     $bmp = New-Object System.Drawing.Bitmap($size, $size)
     $g = [System.Drawing.Graphics]::FromImage($bmp); $g.SmoothingMode = 'AntiAlias'
     $g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(15,23,42))), 0, 0, $size, $size)
     $r = $size * 0.32; $cx = $size / 2; $cy = $size / 2
     $g.FillEllipse((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220,38,38))), [single]($cx-$r), [single]($cy-$r), [single]($r*2), [single]($r*2))
     $g.Dispose(); $bmp.Save("C:\Users\georg\scout\apps\extension\public\icons\icon-$size.png", [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
   }
   ```
   If the user wants a real designed icon, drop it into `apps/extension/public/icons/` and re-export at the four sizes.

2. **`cd C:\Users\georg\scout && pnpm build`** — should succeed now. Output lands in `apps/extension/dist`.

3. **Load unpacked into Chrome** — chrome://extensions → Developer mode → Load unpacked → `apps/extension/dist`. Click the icon, verify the magic-link sign-in shows.

4. **Get an Anthropic API key onto the Edge Functions:**
   ```
   pnpm exec supabase login
   pnpm exec supabase link --project-ref wmicxsafqbixedpjhchc
   pnpm exec supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   pnpm exec supabase functions deploy coach
   pnpm exec supabase functions deploy transcribe
   pnpm exec supabase functions deploy generate-skill
   ```

5. **Smoke test:** sign in with a real email, click Record, do a 30-second workflow on a real page, click Stop, wait for status `ready`, click Generate Skill.

6. **Init git + push to GitHub:**
   ```
   cd C:\Users\georg\scout
   git init
   git add -A
   git commit -m "feat: scout v1 initial build"
   gh auth login                           # interactive — pick GitHub.com → HTTPS → browser
   gh repo create scout --private --source=. --remote=origin --push
   git tag v0.1.0
   git push origin v0.1.0
   ```

## Files of interest

- `BUILD_LOG.md` — chronological log
- `DECISIONS.md` — non-obvious choices and reasoning
- `BLOCKERS.md` — what stopped autonomy and how to unblock
- `README.md` — full setup and user-facing docs
- `docs/SKILL_TEMPLATE.md` — reference output format

## Open questions / TODOs for later

- The new-project form on Supabase didn't surface a region selector beyond "Americas"; the brief asked for `us-east-1` specifically. If region matters, recreate the project via the Supabase Management API with explicit `region: us-east-1`.
- The `transcribe` Edge Function passes audio as a Claude `document` block — confirm the API accepts `audio/webm` for that block type at the time of deploy. If not, swap to a Whisper proxy (OpenAI key) and update `BLOCKERS.md`.
- Per-recording `title` is never set — the popup currently shows "Untitled recording". A nice v0.2 addition: ask Claude for a 3-word title at generation time and patch `recordings.title`.

## What "more flexibility" likely means

The user said they'll give me more flexibility when we resume. Likely changes:
- Pre-installed `gh` and `supabase` CLI (we already installed `gh`)
- An `ANTHROPIC_API_KEY` in the shell env
- Permission settings updated to auto-allow common Bash/Write operations

So when resuming, **first check** `$env:ANTHROPIC_API_KEY` and the available CLIs before falling back to dashboard automation via Playwright.
