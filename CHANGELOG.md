# Changelog

All notable changes to Scout are listed here. Backfilled from `BUILD_LOG.md`.

## [0.2.2] — 2026-05-14

### Added
- **Live Gemini transcription**: offscreen document now runs two parallel `MediaRecorder` instances — one full-session recorder and one 5-second cycling recorder. Each 5 s chunk is independently decodable WebM, base64-encoded, and sent to a new `transcribe-chunk` Edge Function backed by `google/gemini-2.0-flash-001` via OpenRouter. Returned text is appended to a rolling 1 500-char `live_transcript_tail` in session state and passed to the coach.
- **`transcribe-chunk` Edge Function**: new function that accepts a base64 audio chunk, verifies the JWT, transcribes via Gemini 2.0 Flash, and returns plain text.
- **PII acknowledgement modal**: shown once before the first recording. Discloses that screenshots capture visible on-screen text (OCR redaction not in v1) and instructs users not to record sensitive surfaces. Stored in `chrome.storage.local` under `scout:pii_ack`.
- **`report-error` Edge Function**: lightweight error ingestion — receives a PII-free payload from the extension, logs it to Supabase function logs (visible at dashboard → Edge Functions → report-error → Logs). Client-side `reportError()` in the service worker sends flush / transcribe / audio-upload failures automatically.
- **"Report a problem" button** in Settings: prefills a mailto link with the extension version and last error (no PII).
- **RLS test suite** (`supabase/tests/rls.sql`): 216-line SQL test file verifying all row-level security policies.
- **Redaction audit doc** (`docs/REDACTION_AUDIT.md`): complete inventory of what is and isn't redacted before data leaves the browser.
- **CI workflow** (`.github/workflows/ci.yml`): typecheck + smoke test on every push/PR to main. Smoke runs with stub env values so no real Supabase credentials are needed in CI.
- **`preflight.mjs` script** (`pnpm preflight`): local pre-release check — typecheck, env validation, build, smoke test in sequence.
- **`CHANGELOG.md`**: this file.

### Changed
- Replaced Web Speech API live-transcription approach with the Gemini dual-recorder approach (more reliable, no browser speech engine dependency).
- `live_transcript_tail` rolling window increased to 1 500 chars.
- Flush retry uses exponential backoff (1 s, 2 s, 4 s) before falling back to IndexedDB queue.
- `transcribe` edge function retries the LLM call up to 3 times on transient failure.
- Stale-recording auto-fail extended to cover `uploading` and `transcribing` states (previously only `recording`).
- Paused badge restored correctly on service-worker rehydration.
- Structured `[fn reqId]` logging in all 4 edge functions (coach, transcribe, generate-skill, transcribe-chunk).

### Fixed
- Smoke test for `scout:pii_ack` now checks the JS bundle directly (not rendered HTML, where the string doesn't appear).
- Deploy script updated to include `report-error` as the fifth function.

---

## [0.2.1] — 2026-05-08

### Added
- **Improvement mode**: recording mode toggle in the popup; improvement recordings generate a **Change Brief** (friction-focused Claude Code prompt) instead of a `SKILL.md`.
- **Prompt caching**: `anthropic-beta: prompt-caching-2024-07-31` header added to all Anthropic API calls; system prompts marked `cache_control: {type: "ephemeral"}`. Repeated calls within 5 min cost ~10% of normal input tokens.

### Changed
- `generate-skill` now does a single-pass generation (skill or improvement brief, not both) to avoid wasting tokens.
- Popup rotating tips are mode-aware (improvement tips prompt the user to call out confusion, name broken components, etc.).
- Live feed descriptions enriched: paste snippet and form-fill value shown in the feed.
- Auto-download (admin shortcut) now only fires for `kind === "skill"` rows.

---

## [0.2.0] — 2026-05-08

### Added
- **Coach ring buffer**: 40-event ring buffer (`coachRing`) persists across the 5 s flush cycle so the 30 s coach interval always has context to work from.
- **Typed coach replies**: the in-page coach toast now includes a text input; user replies are saved as `coach_reply` events woven into the skill file.
- **Form-fill capture**: `blur` listener captures text-input values on leave (PII-redacted, capped at 120 chars).
- **SPA navigation**: `onHistoryStateUpdated` with 500 ms debounce catches React Router / Next.js / Vue Router route changes.
- **Live capture feed**: popup recording view shows the last 4 meaningful actions in real time.
- **Live transcript tail**: rolling narration display in the popup recording view.
- **PII redaction improvements**: US phone numbers, API keys (`sk-`, `ghp_`, `sbp_`, `AKIA`, `AIza`), and 40+ char hex secrets now redacted.
- **Variable highlighting**: `{snake_case}` placeholders rendered as amber badge chips in the popup; copy panel prompts for values before copying.
- **Stale recording auto-fail**: on cold-start with no active session, recordings stuck in `recording` status > 5 min are marked `failed`.
- **Coach context**: coach payload includes `current_url` and `current_title`.

### Fixed
- Timer accuracy: popup timer now subtracts `paused_ms` and freezes while paused.
- Coach silent-return bug: coach was reading an empty buffer immediately after a flush; ring buffer fixes this.

---

## [0.1.6] — 2026-05-05 (approximate)

### Added
- Library always loads recordings — fixed missing-library bug on popup reopen.
- Mic is now optional: toggle voice narration on/off; preference persisted.
- Popup no longer crashes in dev builds without a configured backend.
- `dev-chrome.ps1` script: spawns a dedicated Chrome with the extension preloaded into an isolated profile.

---

## [0.1.5] — 2026-05-07

### Added
- Admin/guest role split via `app_metadata.role` JWT claim.
- Migration `0003_admin_role.sql`: admins can SELECT all rows; mutations remain user-scoped.
- Encrypted credential vault: `agent_credentials` table with `vault_set`/`vault_get` SECURITY DEFINER functions using pgcrypto.
- Skill versioning UI: version pill buttons in the popup; library card shows latest.
- Dry-run button for admins.
- Variable detection in `generate-skill`: system prompt emits `## Variables` section with `{snake_case}` placeholders.

---

## [0.1.4] — 2026-05-06

### Added
- Universal login (dual-client Supabase architecture): `getAuthSupabase()` points at a shared identity hub; `getDataSupabase()` owns Scout's data. A single sign-in works across Orage apps.
- Library tab added to the popup.
- Background worker rehydration tightened: session key `recording_session` in `chrome.storage.session`; `loadSession`/`saveSession` guard every mutation.

### Changed
- Popup flow simplified: idle → recording → result (no intermediate "magic link sent" screen).
- OTP login replaces email-link flow for reliability.

---

## [0.1.3] — 2026-05-05 (approximate)

### Added
- Friction-reduced auth flow; universal auth project pattern introduced.
- Magic-link 6-digit OTP replaces email-link.

---

## [0.1.2] — 2026-05-04

### Fixed
- Live feedback: popup now shows live event/screenshot counts (`popup:counts` message).
- Content script injection into pre-existing tabs on recording start.
- Screenshot capture: initial screenshot at recording start; screenshots on tab switch and `webNavigation.onCompleted`.
- Popup preflight warning on `chrome://` and webstore pages.

---

## [0.1.1] — 2026-05-03 (approximate)

### Fixed
- Smoke test env fix: `envDir: "../../"` added to `vite.config.ts` so Vite reads `.env` from the workspace root.
- Smoke test selectors tightened.

---

## [0.1.0] — 2026-05-02

### Added
- Initial release.
- Chrome MV3 extension: service worker, content scripts, offscreen MediaRecorder, popup UI.
- Supabase backend: `recordings`, `events`, `skills`, `coach_log`, `profiles` tables with RLS.
- Three Edge Functions: `coach` (30 s coaching tick), `transcribe` (audio → segments JSON), `generate-skill` (SKILL.md generation).
- OpenRouter integration: all LLM calls route through OpenRouter; model overrides via Supabase secrets.
- PII redaction: CC, SSN, EIN, email, password fields redacted before upload.
- Playwright smoke test.
- GitHub Actions release workflow: tag push → build → CWS upload.
