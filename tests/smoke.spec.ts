// Playwright smoke test. Loads the built extension into a persistent Chromium
// context and exercises the end-to-end flow. Requires `pnpm build` first and
// a `.env` with Supabase + Anthropic configured.

import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const EXT_DIR = path.resolve(__dirname, "../apps/extension/dist");
const USER_DATA_DIR = path.resolve(__dirname, ".chrome-profile");

let context: BrowserContext;

test.beforeAll(async () => {
  if (!fs.existsSync(EXT_DIR)) {
    throw new Error(
      `Extension build not found at ${EXT_DIR}. Run \`pnpm build\` first.`,
    );
  }
  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, // MV3 extensions don't load in headless yet
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
});

test.afterAll(async () => {
  await context.close();
});

test("extension loads", async () => {
  // Wait for the service worker.
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker");
  expect(sw).toBeTruthy();
  const url = sw.url();
  expect(url).toContain("chrome-extension://");
});

test("popup opens with sign-in prompt", async () => {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);
  // The email input is the unambiguous tell that the signed-out view rendered.
  // Wait on it first (popup hydrates async via Supabase auth.getSession).
  await expect(popup.locator("input[type=email]")).toBeVisible({ timeout: 10000 });
  await expect(popup.locator("#app")).toContainText("Scout");
});

test("simulated workflow page", async () => {
  // The smoke test in §11.2.5 expects a bundled test page; we use a data URL
  // with three buttons, an input, and an in-page anchor to exercise selectors
  // without losing the page (clicking a relative href would re-navigate the
  // data URL away from itself).
  const page = await context.newPage();
  await page.goto(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`
      <!doctype html><html><body style="font:14px sans-serif;padding:24px;">
        <h1>Scout test page</h1>
        <button data-testid="approve">Approve</button>
        <button data-testid="reject">Reject</button>
        <input data-testid="note" placeholder="Note" />
        <a href="#next" data-testid="next">Next</a>
      </body></html>`),
  );
  await expect(page.locator("h1")).toHaveText("Scout test page");
  // Click each control to generate events the content script will pick up.
  await page.click("[data-testid=approve]");
  await page.fill("[data-testid=note]", "looks fine");
  await page.click("[data-testid=reject]");
  await page.click("[data-testid=next]");
  // Page should still be present (anchor doesn't navigate away).
  await expect(page.locator("h1")).toHaveText("Scout test page");
});
