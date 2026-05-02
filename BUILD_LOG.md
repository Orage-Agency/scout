# Build Log

Append-only running log of meaningful actions, in chronological order.

---

- 2026-05-01 — Started build. Read brief. Verified env: node 25.9, pnpm 10.33, npm 11.12, git 2.53, winget present. `gh` CLI and `supabase` CLI not installed; `gh` install kicked off via winget in background. No ANTHROPIC_API_KEY / SUPABASE_ACCESS_TOKEN / GH_TOKEN in env. Logged blockers. Continuing per Operating Rule 1.1.
- 2026-05-01 — Phase 1 started: created scout/ root and full directory tree (apps/extension, supabase/migrations, supabase/functions/{coach,transcribe,generate-skill,_shared}, docs/, tests/).
- 2026-05-01 — Wrote all foundation files: workspace package.json, pnpm-workspace.yaml, .gitignore, .env.example, BUILD_LOG/DECISIONS/BLOCKERS, extension package.json, tsconfig, vite.config, tailwind.config, postcss.config, manifest.json, popup index.html + styles.css, offscreen index.html.
- 2026-05-01 — Wrote all extension lib code: types.ts, supabase.ts, selector.ts (multi-strategy with data-testid > id > aria-label > name > text > css), redaction.ts (CC/SSN/EIN/email/password redaction), queue.ts (IndexedDB durable queue), ids.ts.
- 2026-05-01 — Wrote service worker (background/index.ts) — RecordingSession with start/stop/pause/resume, in-memory buffer + 5s flush, screenshot capture per event via chrome.tabs.captureVisibleTab, cross-tab capture via tabs.onActivated/onUpdated/webNavigation.onCommitted, coach loop every 30s with hard rate-limit (60s gap, 6 max).
- 2026-05-01 — Wrote content script — capture mousedown/keydown/paste/copy/focusin/scroll, in-page floating draggable control bar, coaching toast UI with slide+dismiss.
- 2026-05-01 — Wrote offscreen document — MediaRecorder for audio, webm/opus, 1s chunk cadence, posts blob to service worker on stop.
- 2026-05-01 — Wrote popup UI — vanilla TS, marked for markdown render, signed-out/magic-sent/idle/recording/skill views, Library tab with status pills, Settings with sign-out + delete-all-data.
- 2026-05-01 — Wrote migration 0001_initial.sql — profiles/recordings/events/skills/coach_log tables, RLS on all five, storage policies in conditional do$$ blocks, handle_new_user trigger.
- 2026-05-02 — Wrote Edge Functions: _shared/anthropic.ts (Claude client with image+document blocks), _shared/supabase.ts (admin + user clients, CORS), coach/index.ts (200-token JSON ask), transcribe/index.ts (audio→segments JSON), generate-skill/index.ts (sample ≤12 screenshots, summarize events, build SKILL.md).
- 2026-05-02 — Wrote README, SKILL_TEMPLATE.md, Playwright smoke test (extension load, popup sign-in, simulated workflow page).
- 2026-05-02 — Started `pnpm install` in background — completed exit 0.
- 2026-05-02 — Provisioned Supabase project via dashboard (Playwright): name `scout`, ref `wmicxsafqbixedpjhchc`, URL `https://wmicxsafqbixedpjhchc.supabase.co`. Captured anon + service-role keys (legacy JWT format). Wrote .env.
- 2026-05-02 — Applied 0001_initial.sql via SQL editor (Ctrl+V from clipboard, Ctrl+Enter, confirm-destructive). Result: "Success. No rows returned."
- 2026-05-02 — Created storage buckets `screenshots`, `audio`, `skills` (all private) via Storage REST API with service-role key.
- 2026-05-02 — Re-ran 0001_initial.sql so the storage-policy `do $$` blocks attach (they were no-ops the first time because buckets didn't exist yet). Success.
- 2026-05-02 — `pnpm build` failed: TS compiled clean after fixing 2 errors (ids.ts crypto narrowing, background unused import), but vite build needs `apps/extension/public/icons/icon-{16,32,48,128}.png` which don't exist yet. Icon-generation script saved in RESUME.md for next session.
- 2026-05-02 — User paused the run; saved RESUME.md with full state for next session pickup.
