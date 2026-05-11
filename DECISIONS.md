# Decisions

Non-obvious choices made during the build, with reasoning. Two sentences each.

---

## D1 — Project root location: `C:\Users\georg\scout`
The user's working directory was `C:\Users\georg`; created `scout/` directly under it for clarity. No git repo at parent, so initializing fresh inside `scout/`.

## D2 — gh CLI installed via winget; Supabase CLI deferred to project devDep
`gh` is system-level and used for repo creation; the brief authorizes `gh repo create`. Supabase CLI added as a project devDependency so `pnpm exec supabase` is reproducible without a global install.

## D3 — No global `pnpm exec` for Supabase migrations until project credentials exist
Supabase MCP is not connected in this environment, so the project itself cannot be auto-provisioned. Migrations and edge function code are written and committed; the user runs `supabase link` + `pnpm db:push` once they have created the project. Documented in BLOCKERS.md and README.md.

## D4 — LLM API key is an Edge Function secret, never a Vite env
Keys never live in the extension. `_shared/llm.ts` reads `ANTHROPIC_API_KEY` first (direct Anthropic API) and falls back to `OPENROUTER_API_KEY` (OpenRouter). In production we set `OPENROUTER_API_KEY` via `supabase secrets set` — it routes through OpenRouter so we can swap models without code changes. The extension calls Edge Functions with the user's Supabase JWT; no key ever reaches the browser.

## D5 — Vanilla TS popup, no React
Per Operating Rule 1.5 (prefer simple). The popup is small enough that the cost of a framework outweighs the benefit. Tailwind handles styling; routing is a tiny hash-based switch.

## D6 — `@crxjs/vite-plugin` for MV3 builds
Industry-standard plugin for Vite + MV3. Handles content scripts, service worker, and HMR for the popup automatically.

## D7 — Recording session state lives in `chrome.storage.session`
`chrome.storage.session` is wiped on browser restart but survives service-worker shutdowns, which is exactly what we need. Restoration on worker wake-up is in `RecordingSession.rehydrate()`.

## D8 — Events buffered in memory, flushed every 5s; failed flushes queue to IndexedDB
Per §11.2.3 (network drop handling). The IndexedDB queue is the durable fallback; on next successful flush, it drains in order before new events.

## D9 — Coach loop fires every 30s, but rate-limit is enforced in client (not just prompt)
Per §9.4.5. Hard guard in service worker: `lastAskAt` and `askCount` in `chrome.storage.session`. The model is told the rules but the worker enforces them.

## D10 — Screenshots are JPEG quality 70 via `chrome.tabs.captureVisibleTab`
Brief recommends JPEG q70 for the size/quality tradeoff. Stored at `<user_id>/<recording_id>/<event_id>.jpg` in the `screenshots` bucket.

## D11 — Selector strategy: data-testid > id > aria-label > name > visible-text+tag > short CSS path
Per §7.5. Implemented as a single function `buildSelector(el)` in `apps/extension/src/lib/selector.ts` that returns the highest-priority match.

## D12 — Audio recorded via offscreen document, MediaRecorder + webm/opus
Service worker can't access `MediaRecorder` per MV3. Offscreen doc lifetime is tied to the recording session; created on start, closed on stop.

## D13 — Toast UI is a self-contained content-script overlay (no Shadow DOM)
Shadow DOM would isolate styles but complicates rendering on sites with strict CSP. Inline scoped styles with high specificity is enough for v1; bound to z-index 2147483647 (max).

## D14 — `claude-opus-4-5` model used in all Edge Functions
The brief specifies it for `/transcribe` and `/generate-skill`, and it's a reasonable choice for `/coach` too (small prompts, low latency target acceptable). If cost matters in v2, swap to `claude-haiku-4-5` for `/coach`.

## D15 — Smoke test uses Playwright (Chromium with extension load)
The brief's Playwright MCP isn't directly callable as a build-time test — it's the runtime browser automation. We add `@playwright/test` as a devDep and write a `tests/smoke.spec.ts` that the user (or CI) runs.
