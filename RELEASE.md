# Releasing Scout to the Chrome Web Store

Scout ships through an **unlisted** Chrome Web Store listing. Anyone with the
listing URL can install in one click; the extension does not appear in store
search. Updates are pushed automatically by GitHub Actions on every `v*` tag.

## First-time setup (one-time)

These steps require human action and only need to happen once.

### 1. Register a Chrome Web Store developer account ($5)

1. Go to <https://chrome.google.com/webstore/devconsole>.
2. Sign in with the Google account that will own the Scout listing
   (recommended: `team@orage.agency`).
3. Pay the one-time $5 registration fee.

### 2. Submit v0.1.0 manually

The first upload has to be done through the dev-console UI to seed the
listing metadata.

1. From repo root: `pnpm package` — produces `release/scout-v0.1.0.zip`.
2. In the dev console: **New item** → upload the zip.
3. Fill in:
   - **Description:** copy the README intro.
   - **Category:** Productivity.
   - **Visibility:** Unlisted.
   - **Privacy policy URL:** `https://orage-agency.github.io/scout/privacy/`
     (served from `docs/privacy.md` via GitHub Pages — enable Pages on
     `Settings → Pages → Source: main / docs` if not already on).
   - **Permission justifications:** see `docs/cws-permission-justifications.md`.
   - **Screenshots:** upload `tests/screenshots/cws/*.png`.
4. Submit for review. First review takes 1–3 business days.

### 3. Capture credentials for CI

After the listing is approved, gather the four secrets the GitHub Action
needs:

- **`CWS_EXTENSION_ID`** — visible at the top of the dev-console listing
  page (32-char string).
- **`CWS_CLIENT_ID`**, **`CWS_CLIENT_SECRET`**, **`CWS_REFRESH_TOKEN`** —
  follow Google's [Chrome Web Store API quickstart](https://developer.chrome.com/docs/webstore/using-api).
  In short:
  1. Create a Google Cloud project, enable the **Chrome Web Store API**.
  2. Create an **OAuth 2.0 Client ID** of type "Desktop app".
  3. Use the helper script `scripts/get-cws-refresh-token.mjs` (run it
     locally — opens a browser, prompts for Google sign-in, prints the
     refresh token) — or follow the manual flow in the docs above.
  4. Add all four values as **Repository secrets** in
     `github.com/Orage-Agency/scout/settings/secrets/actions`.

Also add the runtime secrets the build needs:

- **`VITE_SUPABASE_URL`** — `https://wmicxsafqbixedpjhchc.supabase.co`
- **`VITE_SUPABASE_ANON_KEY`** — copy from `.env`

### 4. Enable GitHub Pages for the privacy policy

The privacy policy is in `docs/privacy.md` and served at
`https://orage-agency.github.io/scout/privacy/` via GitHub Pages.

1. Go to repo **Settings → Pages**.
2. Under **Source**, select `Deploy from a branch` → branch `main` → folder `/docs`.
3. Save. Pages builds in ~1 minute.
4. Confirm `https://orage-agency.github.io/scout/privacy/` loads before
   submitting the CWS listing (the store validates the URL on submission).

## Day-to-day release flow

After the one-time setup:

```sh
# 1. Bump version in package.json AND apps/extension/src/manifest.json
# 2. Update CHANGELOG.md with the new version section
# 3. Commit
git add package.json apps/extension/src/manifest.json CHANGELOG.md
git commit -m "chore: bump to v0.2.3"

# 4. Tag and push — this triggers the release workflow
git tag v0.2.3
git push origin main v0.2.3
```

The workflow will:

1. Verify the tag matches the manifest version.
2. Build the extension with the production env values.
3. Zip it.
4. Upload to the Chrome Web Store and publish.
5. Attach the zip to a GitHub Release with auto-generated notes.

End users get the update on their installed Chrome within ~24 hours of
publish (Chrome polls `clients2.google.com/service/update2/crx` every few
hours).

## Local install (skip the store)

Useful for testing pre-release builds. From repo root:

```powershell
pnpm install
pnpm build
.\scripts\start-scout.ps1
```

Opens a dedicated Chrome window with the extension preloaded into a profile
at `%LOCALAPPDATA%\Scout\Profile`.

## v0.2.4 — Stop pipeline hardening (2026-05-18)

Fixes a critical bug where clicking the red-square stop button did not reliably
stop the offscreen MediaRecorder, causing extra audio to be appended to
recordings. Four root causes were patched:

1. **Concurrent stop calls** — `stopInFlight` Promise deduplicates all callers.
2. **Hung offscreen after timeout** — `closeOffscreen()` is now called when the
   `audio_done` 8-second timeout fires, guaranteeing the mic indicator clears.
3. **Late content events during teardown** — `is_stopping` flag written to
   session state before any async work begins; `onContentEvent` and
   `captureTabAndQueue` both gate on it.
4. **Silent control-bar failure** — Stop button now shows "…" immediately on
   click, retries once if the SW is waking up, and shows "!" with a tooltip if
   both attempts fail.

Additional safeguards: 30-minute max-duration auto-stop with notification;
SW cold-start detects a dead offscreen (mic session lost on browser restart)
and marks the recording failed rather than silently resuming without audio.

Added `"notifications"` permission to manifest.
