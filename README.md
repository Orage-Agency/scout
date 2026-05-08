# Scout v1

A Chrome extension that captures human workflows and turns them into structured `SKILL.md` files for AI agents.

---

## What's new in v0.1.6

### Your recordings now follow you everywhere

Before this update, the Library tab could show up empty even though your recordings were safely saved. This happened because of a timing glitch when the extension first opened — it would try to load your recordings before it had finished logging you in behind the scenes. That's fixed. Now your full recording history loads correctly every time you open the extension, on any device, as long as you're signed in with the same account.

### You can now choose whether to use your microphone

There's a new **Voice narration ON/OFF toggle** on the Record tab, right below the big record button.

- **ON (default):** Scout records your mic while you work. Talk through what you're doing — "I'm filtering by this date because…", "I always check this field first" — and that narration gets transcribed and woven into the skill file. The more you explain, the smarter the output.
- **OFF:** Scout records only your clicks, keystrokes, and screenshots. No mic, no audio file, no transcription step. The skill still gets generated, just from actions alone.

Your choice is saved. You don't have to set it every time.

**How you can tell what's happening:**

| Where | What you see |
|---|---|
| Record tab | Toggle showing ON or OFF |
| Recording view (popup) | 🎙 **live** (pulsing green) · 🎙 **off** · 🎙 **denied** |
| Floating bar (in the page) | 🎙 icon appears and gently pulses while mic is active |

When the mic is off, recording stops faster too — it skips the audio upload and transcription wait entirely and jumps straight to generating your skill.

---

> See `scout_v1_build_brief.pdf` (in the user's Downloads at build time) for the full product brief.

## Install

- **End users** — install from the unlisted Chrome Web Store listing (link
  populated after the first review approves; see [`RELEASE.md`](./RELEASE.md)).
- **Developers / pre-release testing** — clone the repo, run `pnpm install &&
  pnpm build`, then `scripts/start-scout.cmd`. Opens a dedicated Chrome
  window with the unpacked extension preloaded into a separate profile so it
  doesn't touch your main browser.

Privacy policy: <https://gist.github.com/Orage-Agency/788e7dcf7a0ec71c5e9bf7438746e651>

## Architecture

- **Chrome MV3 extension** (`apps/extension`) — service worker (recording session manager), content scripts (per-tab event listeners), offscreen document (`MediaRecorder` for audio), popup UI.
- **Two Supabase projects** (since v0.1.4):
  - **Auth (universal)** — shared identity hub across Orage apps. Owns `auth.users` and the session lifecycle. The extension calls `signIn` / `signUp` / `signOut` here.
  - **Data (Scout)** — owns `recordings`, `events`, `skills`, storage buckets, and the three Edge Functions. Receives the access token issued by the auth project.
- **Anthropic API** — called only from Edge Functions. The extension never holds the key.

### Universal login (optional)

The extension uses two Supabase clients (`getAuthSupabase()` and `getDataSupabase()` in `apps/extension/src/lib/supabase.ts`). The auth client owns the session; the data client mirrors it via `setSession()` whenever auth state changes.

**Single-project mode (default)** — leave `VITE_AUTH_SUPABASE_*` blank in `.env`. Both clients point at the data project; users live in the data project's `auth.users`; RLS works natively. This is what Scout v0.1.4 ships with today.

**Dual-project mode** — set `VITE_AUTH_SUPABASE_URL` and `VITE_AUTH_SUPABASE_ANON_KEY` to a separate "universal" Supabase project. Other Orage apps point at the same auth project so a single login works everywhere. Three additional steps required:
1. Copy the **JWT Secret** from the auth project (Settings → API → JWT Settings) into the data project's JWT Secret field. Without this, every data-project query returns 401.
2. Apply migration `0002_universal_auth.sql` against the data project — drops FKs from `recordings/events/skills/profiles → auth.users` (the universal user UUIDs are foreign to the data project's `auth.users`) and removes the local signup trigger.
3. Set Edge Function secrets `AUTH_SUPABASE_URL` and `AUTH_SUPABASE_ANON_KEY` so the functions verify caller identity against the auth project.

## Setup (one-time, ~5 minutes)

### 1. Provision Supabase

If the [Supabase MCP](https://supabase.com/docs/guides/getting-started/mcp) is configured in Claude Code, the build script creates the project automatically. Otherwise:

1. Go to <https://supabase.com/dashboard> → **New project**.
2. Name: `scout`. Region: `us-east-1`. Generate and save a strong DB password.
3. Wait for provisioning (~2 min).
4. Settings → API → copy the **Project URL**, the **anon** key, and the **service_role** key.
5. In the project: **Storage** → create three private buckets:
   - `screenshots`
   - `audio`
   - `skills` (optional)

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
pnpm exec supabase db push                  # applies migrations 0001_initial.sql + 0002_universal_auth.sql
```

### 4. Set the Edge Function secrets

```bash
# OpenRouter key (Edge Functions route LLM calls through OpenRouter).
pnpm exec supabase secrets set OPENROUTER_API_KEY=sk-or-v1-...

# Universal auth project URL + anon key. Edge Functions verify caller
# identity against this project (since v0.1.4) — without these, every
# function returns 401.
pnpm exec supabase secrets set AUTH_SUPABASE_URL=https://YOUR_AUTH_PROJECT_REF.supabase.co
pnpm exec supabase secrets set AUTH_SUPABASE_ANON_KEY=...
```

### 5. Deploy the Edge Functions

```bash
pnpm exec supabase functions deploy coach
pnpm exec supabase functions deploy transcribe
pnpm exec supabase functions deploy generate-skill
```

### 6. Build the extension and load it

```bash
pnpm build
# Open chrome://extensions → toggle Developer mode → Load unpacked
# → select apps/extension/dist
```

## Recording your first workflow

1. Click the Scout icon → enter your email → click the magic-link in your inbox.
2. Click **Start Recording**. Chrome will prompt for screen + microphone permission once.
3. A floating control bar appears in the top-right of every tab. It survives tab switches and SPA navigation.
4. Perform the task. Narrate as you go. Scout may surface a small toast in the bottom-right with a clarifying question — answer it out loud or click **Skip**.
5. Click **Stop**. Within ~60s the recording lands in **Library** with status `ready`.

## Generating a skill file

1. **Library** → click the recording.
2. Click **Generate Skill**. A side panel renders the resulting `SKILL.md`.
3. Use **Download .md**, **Copy**, or **Regenerate** (with optional extra guidance) as needed.

## Privacy

- Password fields, credit-card numbers, emails (in keystrokes), SSNs, and EINs are redacted **before** any data leaves the browser.
- Screenshot OCR-redaction is **not** in v1 — visible on-screen PII is captured. Don't record sensitive surfaces.
- Incognito tabs aren't captured (extensions don't run there by default).
- A red dot in the in-page control bar makes recording state visible at all times.

## Troubleshooting

- **"Could not start recording. Are you signed in?"** — the popup couldn't find a Supabase session; sign in again from the popup.
- **No coaching toasts ever appear** — `ANTHROPIC_API_KEY` is probably not set in Edge Function secrets. Run the command in Setup §4.
- **Screenshots missing on `chrome://` or `about:` pages** — Chrome blocks `captureVisibleTab` on those URLs. The recording continues; only those events get a `screenshot_path = null`.
- **Service worker stopped during a long recording** — chrome.storage.session restores it on the next event. If something looks wrong, reload the extension and check `chrome://extensions/?errors`.

## Repo layout

```
scout/
├── apps/extension/      # MV3 extension (Vite + TS + Tailwind + crxjs plugin)
│   ├── src/
│   │   ├── background/  # service worker
│   │   ├── content/     # per-tab event listeners + control bar + toast
│   │   ├── offscreen/   # MediaRecorder host
│   │   ├── popup/       # auth, library, recording state, skill side-panel
│   │   ├── lib/         # supabase client, types, selector, redaction, queue, ids
│   │   └── manifest.json
│   └── ...
├── supabase/
│   ├── migrations/0001_initial.sql  # tables, RLS, profile trigger, bucket policies
│   └── functions/
│       ├── _shared/     # anthropic + supabase helpers
│       ├── coach/       # /coach
│       ├── transcribe/  # /transcribe
│       └── generate-skill/  # /generate-skill
├── docs/SKILL_TEMPLATE.md
├── tests/smoke.spec.ts  # Playwright end-to-end
├── BUILD_LOG.md DECISIONS.md BLOCKERS.md
└── README.md
```

## Scripts

| Script | What it does |
| ------ | ------------ |
| `pnpm dev` | Vite dev server for the extension (HMR on the popup) |
| `pnpm build` | Build the extension into `apps/extension/dist` |
| `pnpm typecheck` | TypeScript without emitting |
| `pnpm db:push` | Apply migrations to the linked Supabase project |
| `pnpm functions:deploy` | Deploy all three Edge Functions |
| `pnpm test:smoke` | Run the Playwright smoke test |

## Status

v0.1.0 — capture + context only. No replay/execution. See the brief's "What v1 does (and does not)" matrix for the full scope.
