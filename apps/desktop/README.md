# @scout/desktop

OS-level capture and (soon) replay for Scout. Cross-platform Electron app that lives in the system tray.

This is **Week 1–2 / Chunks 1–7** of the desktop pivot. Capture, coord-based replay with image-anchor self-healing, screen recording (ffmpeg), Supabase sync, device-link auth, the review UI window, and the Chrome native-messaging bridge are wired. Week 3 brings code signing + MSIX/DMG packaging + MS Store submission.

## Prereqs

- Node 20+
- pnpm 10+
- Native build toolchain for `uiohook-napi` and `@nut-tree-fork/nut-js`:
  - **Windows:** Visual Studio Build Tools (Desktop development with C++)
  - **macOS:** `xcode-select --install`
  - **Linux:** `apt install build-essential libx11-dev libxtst-dev libxkbcommon-dev libxinerama-dev xdotool`

## Install

From the repo root:

```bash
pnpm install
# Rebuild native modules against Electron's ABI:
pnpm --filter @scout/desktop rebuild
```

## Run

```bash
pnpm --filter @scout/desktop dev
```

A tray icon appears in the system tray.

| Action | Tray menu | Global shortcut |
|---|---|---|
| Open Scout window | **Open Scout window…** | `Ctrl+Shift+S` |
| Start / stop recording | **Start recording** / **Stop recording** | `Ctrl+Shift+R` |
| Replay last recording | **Replay last recording…** | `Ctrl+Shift+P` |
| Abort active replay | **Abort replay** | `Ctrl+Shift+X` |

The review window lists every recording with replay/sync/delete actions, shows live capture/replay/sync state, and is the one-stop UI for users who'd rather not hunt through the tray.

Replay shows a confirmation dialog, then a 3-second countdown — switch to your target app before the countdown hits zero. Mouse + keyboard events are dispatched at the original timing.

**Self-healing clicks:** every `mousedown` captures an 80×80 px image anchor centered on the click point. At replay time, the anchor is located on the current screen via image search (confidence ≥ 0.85) and the click is dispatched at the found region's center. If the anchor can't be found (UI changed too much, theme swap, content reflowed) replay falls back to the original (x, y) coordinate. Replay log records `anchorHits` vs `anchorMisses` so you can audit reliability per recording.

**Screen recording:** alongside each capture session, ffmpeg records the primary display to `video.mp4` at 15 fps (H.264, CRF 28). On macOS you'll need to grant **Screen Recording** permission the first time. To disable, set `record_screen: false` in `settings.json`.

## Sync to Supabase

Recordings stay local until you sign in.

1. Tray → **Sign in to Scout** — a window opens with an 8-character code and auto-launches your browser to the verification page.
2. Approve the device in your browser (you must already be signed in to the Scout extension or web app).
3. The desktop window detects the approval, saves the tokens, and closes.
4. Tray → **Sync now** — uploads any unsynced recording. Auto-runs after every stop.

The Supabase project URL and anon key are **bundled into the build** (set `SCOUT_SUPABASE_URL` / `SCOUT_SUPABASE_ANON_KEY` env vars at compile time). The access token from device-link auto-refreshes ~60 s before expiry — no manual re-pasting.

Events land in your existing `events` table tagged with `data.source = "desktop"`. The `recordings` row starts at `status = "uploading"` and flips to `"ready"` once the screen video uploads. Anchor PNGs go to the `anchors` storage bucket under `<user_id>/<recording_id>/anchors/<event_id>.png`. Screen videos go to `videos/<user_id>/<recording_id>/video.mp4`.

Run migrations `0008_desktop_video.sql` (storage buckets + `recordings.video_path`) and `0009_device_codes.sql` (device-link table) once, and deploy the `device-link` edge function. Set `DEVICE_VERIFICATION_URL` on the function to the URL of your approval page (defaults to `https://scout.orage.agency/device`). The approval page ships inside the Chrome extension at `chrome-extension://<id>/src/device-approve/index.html` — host a tiny redirect at that domain that forwards to it.

Already-synced recordings are tracked in `settings.json` (`synced_recording_ids`) so they aren't re-uploaded.

> **Fallback paste-token flow** is still available behind the *Advanced* disclosure in the sign-in window — useful for self-hosted setups where the device-link function isn't deployed.

## Where recordings go

Captured events stream to NDJSON on disk:

- **Windows:** `%APPDATA%\scout-desktop\recordings\<recording-id>\events.ndjson`
- **macOS:** `~/Library/Application Support/scout-desktop/recordings/<recording-id>/events.ndjson`
- **Linux:** `~/.config/scout-desktop/recordings/<recording-id>/events.ndjson`

A `session.json` sidecar records start/end timestamps and event count.

## Permissions

- **macOS:** First run will prompt for **Accessibility** *and* **Input Monitoring** permission (System Settings → Privacy & Security). Required for global input hooks. Without these, capture silently records nothing.
- **Windows:** No prompt; works out of the box.
- **Linux:** X11 only for now (Wayland support is a Week 3 task).

## Roadmap

| Week | Deliverable |
|---|---|
| 1 | ✓ Capture, tray, NDJSON sink, coord-based replay, ✓ Supabase sync, ✓ screen recording, ✓ image-anchor self-healing |
| 2 | ✓ Device-link auth + refresh tokens, ✓ review UI window, ✓ native-messaging bridge to Chrome extension |
| 3 (now) | Windows UIA / macOS AX selector resolution, code signing, MSIX + DMG bundle, Microsoft Store submission |

## Chrome bridge

The desktop tray opens a 127.0.0.1:5391 loopback socket. A native-messaging broker at `apps/desktop/scripts/native-host.js` forwards Chrome's stdio framing onto that socket so the Scout extension can call:

```ts
import { connect, startDesktopRecording, adoptDesktopSession } from "../lib/native-bridge";
await connect();
await startDesktopRecording();
```

Install once after first run so Chrome can find the host:

```bash
pnpm --filter @scout/desktop install-native-host -- --extension-id <your-extension-id>
```

Manifest is written to the platform-specific Chrome NativeMessagingHosts directory; on Windows a HKCU registry pointer is added for Chrome, Chromium, and Edge.

## Packaging & distribution

Production builds are produced by `electron-builder`. The full config lives in `electron-builder.yml`; secrets are passed via env vars so nothing sensitive is committed.

```bash
# Bundle the Supabase project into the build so first-launch is zero-config.
export SCOUT_SUPABASE_URL="https://<your-project>.supabase.co"
export SCOUT_SUPABASE_ANON_KEY="eyJhbGc..."

# Windows: NSIS installer + MSIX/Appx for the Microsoft Store.
export CSC_LINK="base64-pfx-or-https-url"
export CSC_KEY_PASSWORD="..."
pnpm --filter @scout/desktop dist:win

# macOS: signed DMG + zip (for auto-update), notarized.
export CSC_LINK="..."         # Developer ID Application cert
export CSC_KEY_PASSWORD="..."
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="ABCDE12345"
pnpm --filter @scout/desktop dist:mac

# Linux: AppImage + .deb (unsigned by default).
pnpm --filter @scout/desktop dist:linux
```

Artefacts land in `apps/desktop/release/`. Upload the `latest*.yml` + `*.blockmap` files alongside the binaries to `https://scout.orage.agency/updates/${os}/${arch}/` and electron-updater will pick them up on every install — no extra config in the client.

### Microsoft Store

`pnpm dist:win` produces both an NSIS `.exe` (sideloadable) and an `.appx` for the Microsoft Store. Submit the `.appx` via Partner Center:

1. Reserve `OrageAgency.Scout` as the package name.
2. In the submission, declare the **`runFullTrust`** capability — uiohook-napi installs a low-level Windows hook (`WH_KEYBOARD_LL` / `WH_MOUSE_LL`) which the AppContainer sandbox blocks. Without `runFullTrust` Scout records nothing.
3. The auto-update channel in `publish:` is ignored for Store builds — the Store handles updates. Sideloaded NSIS installs use electron-updater.

### macOS DMG

We ship outside the App Store because MAS sandboxing forbids global input hooks. `hardenedRuntime: true` + entitlements in `build/entitlements.mac.plist` + notarization via `build/notarize.js` give Gatekeeper-clean DMGs that users can install without "open anyway" warnings.

### Auto-update

`electron-updater` is wired into the main process (`src/main/updater.ts`). On a packaged build, it checks the publish URL ~10 s after launch and every 6 h thereafter. Dev builds (`pnpm dev`) skip the check.

## Known gaps in this chunk

- Image anchor lookup runs synchronously during replay — each anchor search adds ~0.5–2 s to the click's wall time. Replay timing of clicks is distorted relative to capture; key-event timing between clicks is preserved.
- Mouse-wheel events are captured but **not** replayed (apps interpret scroll deltas too inconsistently for a naive replay).
- Unmapped keycodes (rare punctuation, IME composition, media keys) are skipped during replay.
- ffmpeg-static bundles a ~70 MB binary per platform. Acceptable for a desktop install; flagged here so the bundle size isn't a surprise.
- macOS: anchor capture and screen recording both require the **Screen Recording** privacy permission.
- Device-link verification URL defaults to `https://scout.orage.agency/device`. If you self-host, set `DEVICE_VERIFICATION_URL` on the edge function and host a redirector that opens the extension's `device-approve` page.
- Tray icon falls back to a transparent 16×16 PNG if `assets/tray-icon.png` is missing.
