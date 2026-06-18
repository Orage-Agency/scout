# Microsoft Store submission checklist

Pre-submission steps for the Scout desktop MSIX. Follow in order; missing the `runFullTrust` capability is the most common cause of "silent recording" bug reports after first install.

## 1. Reserve the app name

1. Sign in to [Partner Center](https://partner.microsoft.com/dashboard).
2. **Apps and games → New product → MSIX or PWA app**.
3. Reserve name: **Scout**.
4. Note the package identity assigned by the Store — it should match what is in `electron-builder.yml`:
   - `identityName: OrageAgency.Scout`
   - `publisher: CN=OrageAgency` (replace with the publisher CN that Partner Center shows in **Product identity**)

## 2. Configure the submission

Under **Properties**:

- **Category:** Productivity → Office and business tools
- **Privacy policy URL:** https://scout.orage.agency/privacy
- **Support contact info:** baruc@orage.agency
- **System requirements:** Windows 10 1809+ (build 17763), x64
- **Hardware preferences:** keyboard + mouse required

Under **Pricing and availability**:

- **Markets:** all
- **Visibility:** Public
- **Pricing:** Free

Under **Properties → Product declarations**:

- ✅ This product accesses, collects, or transmits personal info (we sync recordings to Supabase)
- ✅ This product uses internet access
- ❌ This product is suitable for children

## 3. Capabilities (most important)

The store flags `runFullTrust` as a **restricted capability**. Submission goes to a manual review queue (~3–5 business days first time).

Justification text to paste in the capability description field:

> Scout records user-initiated mouse and keyboard activity across desktop applications so the user can replay or share their own workflows. This requires installing low-level Windows hooks (`SetWindowsHookEx` with `WH_KEYBOARD_LL` / `WH_MOUSE_LL`) which the AppContainer sandbox blocks. Capture and replay are explicitly user-triggered from a tray icon; no data is recorded without user action. Recordings are stored locally by default and only uploaded to the user's own Scout account.

`runFullTrust` is declared in `build/appxmanifest.xml` and pulled into the generated `.appx` via `customManifestPath` in `electron-builder.yml`.

## 4. Build the package

```bash
export SCOUT_SUPABASE_URL="https://<your-project>.supabase.co"
export SCOUT_SUPABASE_ANON_KEY="..."
export CSC_LINK="base64-or-url-to-pfx"
export CSC_KEY_PASSWORD="..."

pnpm --filter @scout/desktop dist:win
```

Artefacts land in `apps/desktop/release/`:

- `Scout-Setup-<version>.exe` — NSIS sideload installer (electron-updater target)
- `Scout-<version>-win-x64.appx` — Store package (upload this)
- `latest.yml` + `*.blockmap` — auto-update metadata (upload to your CDN at `https://scout.orage.agency/updates/win/x64/`)

## 5. Test the package locally before uploading

```powershell
# Install in dev mode to verify the global hooks work under runFullTrust
Add-AppxPackage -Path "apps/desktop/release/Scout-<version>-win-x64.appx"
# Launch Scout, hit Ctrl+Shift+R, type into Notepad, hit Ctrl+Shift+R again.
# Tray → Replay last recording — Notepad should re-type the same keys.
```

If replay records nothing, the manifest is missing `runFullTrust` — re-check `build/appxmanifest.xml`.

## 6. Store listing copy

**Short description (200 char max):**

> Scout records your mouse and keyboard across any app so you can replay, share, or turn workflows into AI-readable skill files. Local-first, with optional cloud sync.

**Long description:**

> Stop screen-recording yourself. Scout captures every click, keystroke, and screen frame as you work, then replays them on demand — across any desktop app, not just the browser. Recordings stay on your machine until you sign in. When you do, they sync to your Scout account so you can replay them on another device or hand them to an AI agent as a skill file it can execute.
>
> **What you can do:**
> - One-shortcut record/replay of any workflow — `Ctrl+Shift+R`, `Ctrl+Shift+P`.
> - Self-healing clicks: Scout captures a small image anchor around each click so replays survive UI shifts and theme swaps.
> - Pair with the Scout Chrome extension for richer browser context (URLs, element selectors, page screenshots) alongside the OS-level capture.
> - Sync to Scout cloud and turn any recording into a runnable skill file with one click.
>
> **Privacy:**
> - Capture only runs while you're actively recording (tray icon turns red).
> - Recordings live in `%APPDATA%\scout-desktop\recordings\` until you choose to sync.
> - The microphone is **off by default**.

**Screenshots needed (PNG, 1920×1080):**

1. Tray menu open showing **Recording / Idle** state
2. Review window with a few recordings listed
3. Recording in progress with the floating control bar visible
4. Replay confirmation dialog
5. Successful sync to cloud (badge on a recording flips to "Synced")

**Promotional images:**

- 1080×1080 hero (tray icon + tagline)
- 1240×600 narrow hero (workflow recorder visual)

## 7. Age rating

Run the IARC questionnaire from the submission page. Scout has no objectionable content; it should rate "Everyone / PEGI 3 / CERO A".

## 8. Submit

1. Click **Submit to Store**.
2. Wait for Microsoft to email about restricted-capability review (`runFullTrust`).
3. Reply within 24 h if they request more justification or sample recordings.
4. On approval, the package becomes visible at `https://apps.microsoft.com/detail/<product-id>`.

## 9. Post-launch (auto-update)

Store updates are managed by the Store — push a new `.appx` via Partner Center and Windows fetches it.

Sideload installs (NSIS) update via `electron-updater` polling `https://scout.orage.agency/updates/win/x64/latest.yml`. Make sure to upload `latest.yml`, the `.blockmap`, and the `.exe` together.
