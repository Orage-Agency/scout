# Scout v1

> **Latest update (v0.2.7)** — Magic link sign-in, one-command setup, and a first-run guide.
> No more passwords. New users get a 6-digit code by email. `pnpm setup` handles everything from credentials to deployment in one shot.

A Chrome extension that captures human workflows and turns them into structured `SKILL.md` files for AI agents.

---

## What's new in v0.2.7

### Magic link sign-in

Passwords are gone. Enter your email, get a 6-digit code, paste it — done. Works for new and returning users with no separate sign-up step. The code auto-submits when all 6 digits are detected. A "Use a different email" link lets you go back without reloading.

### One-command setup (`pnpm setup`)

New contributors run one command: `pnpm setup`. It checks for Node and pnpm, prompts for Supabase credentials, writes `.env`, installs dependencies, builds the extension, applies all database migrations, and deploys the edge functions. At the end it prints the exact Load Unpacked path.

### Cancel stuck generation

The processing screen now has a **Cancel** button. Clicking it takes you to Library without interrupting the background job — the skill keeps generating and Chrome notifies you when it's ready. If generation takes longer than 90 seconds a warning appears with a nudge to cancel and retry.

### First-run card

First-time users see a three-bullet explainer on the Record tab: record → guide → library. Dismissed with × and never shown again.

---

## What's new in v0.2.6

### Simplified UI

The popup has been stripped of everything a non-technical user doesn't need:

- **Tier picker removed** — Standard quality is always used. No model names, no pricing.
- **Modes renamed** — "Skill" → **How-To Guide**, "Improvements" → **Bug Report**. Plain words.
- **Blurbs rewritten** — "Do the task as you normally would. Scout will turn your recording into a step-by-step guide." No jargon.
- **Recording view decluttered** — Richness bar, event count, screenshot count, and tier badge are gone. Just the timer and a quiet step counter.
- **Extra context screen simplified** — Shorter heading, friendlier copy, "Generate" button instead of "Save & generate".
- **Live feed** renamed from "Live capture feed" to "What Scout is seeing".

---

## What's new in v0.2.5

### Real-time Claude Code feed

Scout now observes every Claude Code tool call the moment it happens — not just after the fact.

- **PreToolUse + PostToolUse hooks** on all tool types (`Bash`, `Write`, `Edit`, `Read`, `Glob`, `Grep`) fire `scripts/scout-broadcast.cjs`, a lightweight Node.js script that reads the hook payload from stdin and broadcasts it to a Supabase Realtime channel named `scout-code`.
- The **Code tab** in the Scout popup subscribes to that channel. Events appear within a second, newest at the top, showing tool name, hook phase (Pre/Post), first line of input, and relative timestamp. A green dot in the tab header confirms the Realtime connection is live.
- The PostToolUse **coaching prompt** (Claude Haiku) is retained on `Bash`, `Write`, and `Edit` — Scout still injects a note if it spots something off.
- `SUPABASE_URL` and `SUPABASE_ANON_KEY` are now set as env vars in `~/.claude/settings.json` so the broadcast script works without any extra configuration.

---

## What's new in v0.2.4

### Skill generation runs in the background

Previously you had to keep the popup open while Scout transcribed and generated your skill file. Now the service worker handles everything after you submit your extra context — you can close the popup, switch tabs, or walk away. Chrome sends a notification when the skill is ready.

### Auth race condition fixed

The "Could not start recording. Are you signed in?" error was caused by the service worker calling `getUser()` (a network round-trip) immediately after waking from hibernation, before the session was restored from storage. Fixed by switching to `getSession()`, which reads from `chrome.storage.local` without a network call.

### Cancel recording is now obvious

The discard button is visibly red and labeled **Cancel recording** instead of the muted "Discard recording" it used to be.

### Load unpacked from the repo root

The build now outputs directly to `scout/` so you can point Chrome's Load Unpacked at `C:\Users\...\Downloads\scout` without navigating into `apps/extension/dist`.

### Scout watches Claude Code (via hook)

A new Claude Code `PostToolUse` hook runs Scout's coaching model (Claude Haiku) after every `Bash`, `Write`, and `Edit` call. If it spots a more efficient approach or something irregular, it injects a `Scout:` note into the active conversation. Silent when everything looks fine. Configured in `~/.claude/settings.json`.

---

## What's new in v0.2.2

### The coach now listens while you record

Previously, the coaching assistant only knew what you clicked — it had no idea what you were saying. Starting in v0.2.2, Scout transcribes your voice every 5 seconds while you record and feeds that running transcript to the coach.

In practice this means:
- If you say "I'm picking this option because of the SLA requirement" and then click something, the coach knows why you made that choice. It won't ask you to explain it.
- If you go quiet for a while and the coach does ask a question, the question is shaped by everything you've narrated so far — not just the last 30 seconds of clicks.
- The transcript tail is capped at 1500 characters (rolling window), so the coach always sees recent context without getting overwhelmed.

**This only activates when Voice narration is ON.** If you've turned mic off, nothing changes.

### How it works (for the technically curious)

Scout runs two `MediaRecorder` instances on the same audio stream:

- **Main recorder** — runs the full session, produces the audio file uploaded for final transcription at the end.
- **Live recorder** — stops and restarts every 5 seconds. Each fresh start writes a new EBML header, making every 5-second window an independently decodable WebM file. Each chunk goes to a new `transcribe-chunk` Edge Function backed by Gemini 2.0 Flash via OpenRouter. The returned text is appended to the rolling transcript tail.

---

## What's new in v0.2.1

### Improvement mode

Alongside the original skill-capture mode, Scout now supports **Improvement mode** — record a session showing something that's confusing or broken, and the output is a structured **Change Brief** (a friction-focused critique ready to paste into Claude Code) instead of a `SKILL.md`.

Switch modes in the popup before you start recording. The coaching tips adjust too: in Improvement mode the coach prompts you to call out confusion, name broken components, and describe what you expected to happen instead.

### Prompt caching

The coaching and skill-generation Edge Functions now send the `anthropic-beta: prompt-caching-2024-07-31` header and mark their system prompts with `cache_control: { type: "ephemeral" }`. Repeated calls within 5 minutes pay roughly 10% of the normal input-token price.

---

## What's new in v0.2.0

### Real-time coaching improvements

- **Coach ring buffer** — the coach now reads from a 40-event ring buffer that survives the 5-second flush cycle. Previously, if a flush happened right before the 30-second coach tick, the coach saw zero events and stayed silent. Fixed.
- **Typed replies to coach questions** — the in-page toast now has a text input. Your answer gets saved as a `coach_reply` event, woven into the skill file.
- **Form-fill capture** — leaving a text field after typing now records a `form_fill` event with the field label and (redacted) value, giving the LLM cleaner action context.
- **SPA navigation** — React Router / Next.js / Vue Router route changes are caught via `onHistoryStateUpdated` with a 500ms debounce.
- **Live capture feed** — the popup shows the last 4 meaningful actions as they happen (click target, paste snippet, form fill, navigation).

### PII redaction additions

US phone numbers, API keys (`sk-`, `ghp_`, `sbp_`, `AKIA`, `AIza`), and long hex secrets are now redacted before any data leaves the browser.

---

## What's new in v0.1.6

- **Library always loads** — recordings no longer go missing when you reopen the extension.
- **Mic is now optional** — toggle voice narration on or off before you start recording. Your choice is remembered.
- **Popup never crashes** — the extension now opens cleanly even in dev builds without a configured backend.

---

## Install

- **End users** — install from the unlisted Chrome Web Store listing (link
  populated after the first review approves; see [`RELEASE.md`](./RELEASE.md)).
- **Developers / pre-release testing** — clone the repo, run `pnpm install &&
  pnpm build`, then `scripts/start-scout.cmd`. Opens a dedicated Chrome
  window with the unpacked extension preloaded into a separate profile so it
  doesn't touch your main browser.

Privacy policy: [PRIVACY.md](./PRIVACY.md) · hosted at <https://orage-agency.github.io/scout/privacy/>

## Architecture

- **Chrome MV3 extension** (`apps/extension`) — service worker (recording session manager), content scripts (per-tab event listeners), offscreen document (two `MediaRecorder` instances: one full-session, one cycling every 5 s for live transcription), popup UI.
- **Two Supabase projects** (since v0.1.4):
  - **Auth (universal)** — shared identity hub across Orage apps. Owns `auth.users` and the session lifecycle. The extension calls `signIn` / `signUp` / `signOut` here.
  - **Data (Scout)** — owns `recordings`, `events`, `skills`, storage buckets, and the four Edge Functions. Receives the access token issued by the auth project.
- **OpenRouter** — all LLM calls route through OpenRouter. Coach uses Claude Haiku (cheap, fast, fires every 30 s). Full transcription and skill generation use Claude Sonnet. Live chunk transcription uses Gemini 2.0 Flash (audio-native, low latency). Model overrides via Supabase secrets.

### Universal login (optional)

The extension uses two Supabase clients (`getAuthSupabase()` and `getDataSupabase()` in `apps/extension/src/lib/supabase.ts`). The auth client owns the session; the data client mirrors it via `setSession()` whenever auth state changes.

**Single-project mode (default)** — leave `VITE_AUTH_SUPABASE_*` blank in `.env`. Both clients point at the data project; users live in the data project's `auth.users`; RLS works natively.

**Dual-project mode** — set `VITE_AUTH_SUPABASE_URL` and `VITE_AUTH_SUPABASE_ANON_KEY` to a separate "universal" Supabase project. Other Orage apps point at the same auth project so a single login works everywhere. Three additional steps required:
1. Copy the **JWT Secret** from the auth project (Settings → API → JWT Settings) into the data project's JWT Secret field. Without this, every data-project query returns 401.
2. Apply migration `0002_universal_auth.sql` against the data project — drops FKs from `recordings/events/skills/profiles → auth.users` and removes the local signup trigger.
3. Set Edge Function secrets `AUTH_SUPABASE_URL` and `AUTH_SUPABASE_ANON_KEY` so the functions verify caller identity against the auth project.

## Setup (one-time, ~5 minutes)

### 1. Provision Supabase

If the [Supabase MCP](https://supabase.com/docs/guides/getting-started/mcp) is configured in Claude Code, the build script creates the project automatically. Otherwise:

1. Go to <https://supabase.com/dashboard> → **New project**.
2. Name: `scout`. Region: `us-east-1`. Generate and save a strong DB password.
3. Wait for provisioning (~2 min).
4. Settings → API → copy the **Project URL**, the **anon** key, and the **service_role** key.
5. In the project: **Storage** → create three private buckets: `screenshots`, `audio`, `skills`.

### 2. Configure `.env`

```bash
cp .env.example .env
# Then fill in:
#   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
#   SUPABASE_DB_PASSWORD, SUPABASE_PROJECT_REF              (data project)
#   VITE_SUPABASE_URL (= SUPABASE_URL)                      (data project)
#   VITE_SUPABASE_ANON_KEY (= SUPABASE_ANON_KEY)            (data project)
#   VITE_AUTH_SUPABASE_URL                                  (universal auth project)
#   VITE_AUTH_SUPABASE_ANON_KEY                             (universal auth project)
```

Then in the Supabase dashboard, copy the **JWT Secret** from the auth project (Settings → API) and paste it into the data project's JWT Secret field. The data project will now accept tokens minted by the auth project.

### 3. Apply the database schema

```bash
pnpm install
pnpm exec supabase login                    # interactive — opens browser
pnpm exec supabase link --project-ref <ref>
pnpm exec supabase db push                  # applies all migrations
```

### 4. Set the Edge Function secrets

```bash
# OpenRouter key — all LLM calls route through OpenRouter.
pnpm exec supabase secrets set OPENROUTER_API_KEY=sk-or-v1-...

# Universal auth project (required for all four Edge Functions to verify JWTs).
pnpm exec supabase secrets set AUTH_SUPABASE_URL=https://YOUR_AUTH_PROJECT_REF.supabase.co
pnpm exec supabase secrets set AUTH_SUPABASE_ANON_KEY=...

# Optional: override the Gemini model used for live chunk transcription.
# pnpm exec supabase secrets set LLM_MODEL_TRANSCRIBE_CHUNK=google/gemini-2.0-flash-001
```

### 5. Deploy the Edge Functions

The deploy script handles all four functions in one shot and exits on first failure. Generate a PAT at <https://supabase.com/dashboard/account/tokens>, then:

```powershell
$env:SUPABASE_ACCESS_TOKEN = "<your-pat>"
powershell -ExecutionPolicy Bypass -File scripts\deploy-edge-functions.ps1
```

Or deploy individually:

```bash
pnpm exec supabase functions deploy coach
pnpm exec supabase functions deploy transcribe
pnpm exec supabase functions deploy generate-skill
pnpm exec supabase functions deploy transcribe-chunk
```

### 6. Build the extension and load it

```bash
pnpm build
# Open chrome://extensions → toggle Developer mode → Load unpacked
# → select apps/extension/dist
```

## Recording your first workflow

1. Click the Scout icon → enter your email → enter the 6-digit OTP from your inbox.
2. Click **Start Recording**. Chrome will prompt for microphone permission once (if Voice narration is ON).
3. A floating control bar appears in the top-right of every tab. It survives tab switches and SPA navigation.
4. Perform the task. Narrate as you go — Scout transcribes your voice live every 5 seconds and uses it to ask smarter coaching questions. The in-page coach may surface a small toast with a question; answer it by typing or clicking **Skip**.
5. Click **Stop**. Within ~60 s the recording lands in **Library** with status `ready`.

## Generating a skill file

1. **Library** → click the recording.
2. Click **Generate Skill**. A side panel renders the resulting `SKILL.md`.
3. Use **Download .md**, **Copy**, or **Regenerate** (with optional extra guidance) as needed.

For **Improvement mode** recordings, the output is a **Change Brief** — a friction-focused markdown critique ready to paste into Claude Code.

## Privacy

- Password fields, credit-card numbers, emails (in keystrokes), SSNs, EINs, US phone numbers, and common API key formats are redacted **before** any data leaves the browser.
- Screenshot OCR-redaction is **not** in v1 — visible on-screen PII is captured. Don't record sensitive surfaces.
- Incognito tabs aren't captured (extensions don't run there by default).
- A red dot in the in-page control bar makes recording state visible at all times.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Could not start recording. Are you signed in?" | No Supabase session | Sign in again from the popup |
| No coaching toasts ever appear | `OPENROUTER_API_KEY` not set | `supabase secrets set OPENROUTER_API_KEY=...` and redeploy |
| Live transcript tail stays empty | `transcribe-chunk` not deployed | Run the deploy script; confirm the function appears in the Supabase dashboard |
| Screenshots missing on `chrome://` pages | Chrome blocks `captureVisibleTab` there | Expected — recording continues, those events get `screenshot_path = null` |
| Service worker stopped mid-recording | Chrome hibernated the SW | `chrome.storage.session` restores state on next event; check `chrome://extensions/?errors` |

## Repo layout

```
scout/
├── apps/extension/      # MV3 extension (Vite + TS + Tailwind)
│   ├── src/
│   │   ├── background/  # service worker — session state, flush, coach loop
│   │   ├── content/     # per-tab event listeners, control bar, coach toast
│   │   ├── offscreen/   # dual MediaRecorder host (full-session + 5-s live chunks)
│   │   ├── popup/       # auth, library, recording state, skill side-panel
│   │   └── lib/         # supabase clients, types, selector, redaction, queue, ids
│   └── ...
├── supabase/
│   ├── migrations/      # 0001_initial.sql  0002_universal_auth.sql  0003_admin_role.sql
│   └── functions/
│       ├── _shared/     # llm.ts (OpenRouter + Anthropic)  supabase.ts (auth + CORS)
│       ├── coach/           # /coach — 30-s coaching tick
│       ├── transcribe/      # /transcribe — full-recording audio → segments JSON
│       ├── transcribe-chunk/# /transcribe-chunk — live 5-s chunk → plain text
│       └── generate-skill/  # /generate-skill — SKILL.md or Change Brief
├── scripts/
│   ├── deploy-edge-functions.ps1  # deploys all four functions in one shot
│   ├── dev-chrome.ps1             # launches Chrome with the extension preloaded
│   └── start-scout.ps1
├── docs/SKILL_TEMPLATE.md
├── tests/               # Playwright end-to-end and smoke tests
├── BUILD_LOG.md  DECISIONS.md  BLOCKERS.md
└── README.md
```

## Scripts

| Script | What it does |
| ------ | ------------ |
| `pnpm dev` | Vite dev server for the extension (HMR on the popup) |
| `pnpm build` | Build the extension into `apps/extension/dist` |
| `pnpm typecheck` | TypeScript without emitting |
| `pnpm db:push` | Apply migrations to the linked Supabase project |
| `pnpm test:smoke` | Run the Playwright smoke test |
| `scripts\deploy-edge-functions.ps1` | Deploy all four Edge Functions (requires `SUPABASE_ACCESS_TOKEN`) |
| `scripts\dev-chrome.ps1` | Open a dedicated Chrome with the extension preloaded |

## Status

v0.2.2 — live Gemini transcription, dual-mode recording (skill + improvement), real-time coach ring buffer, typed coach replies, form-fill capture, SPA navigation, PII redaction improvements. No replay/execution engine. See the brief's "What v1 does (and does not)" matrix for the full scope.
