// Generates screenshots for the Chrome Web Store listing. Not a real test —
// each "test" just renders a popup state and screenshots the viewport at
// 1280x800 (CWS's preferred size).
//
// Run with: pnpm exec playwright test tests/screenshots.spec.ts

import { test, chromium, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import fs from "node:fs";

const EXT_DIR = path.resolve(__dirname, "../apps/extension/dist");
const OUT_DIR = path.resolve(__dirname, "screenshots/cws");
const PROJECT_REF = "wmicxsafqbixedpjhchc";

const envPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

async function setupContext(): Promise<{ context: BrowserContext; extId: string; popupUrl: string }> {
  const profileDir = path.resolve(__dirname, ".chrome-profile-screenshots");
  if (fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,800",
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  return { context, extId, popupUrl: `chrome-extension://${extId}/src/popup/index.html` };
}

test("01 — sign-in screen", async () => {
  test.setTimeout(60_000);
  const { context, popupUrl } = await setupContext();
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 1280, height: 800 });
  await popup.goto(popupUrl);
  await popup.waitForSelector("input[type=email]");
  await popup.screenshot({ path: path.join(OUT_DIR, "01-signin.png"), fullPage: false });
  await context.close();
});

test("02 — recording in progress", async () => {
  test.setTimeout(90_000);
  // Need a signed-in session for the recording view.
  const admin = adminAuthClient();
  const email = `shot-${Date.now()}@scout-test.local`;
  const password = `Pass-${Date.now()}-X!`;
  const { data: created } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const userId = created.user!.id;

  const userSb = userAuthClient();
  const { data: signed } = await userSb.auth.signInWithPassword({ email, password });
  const session = signed.session!;

  const { context, popupUrl } = await setupContext();
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 1280, height: 800 });
  await popup.goto(popupUrl);
  await popup.evaluate(async ({ projectRef, sess }) => {
    await chrome.storage.local.set({ [`sb-${projectRef}-auth-token`]: JSON.stringify(sess) });
  }, { projectRef: PROJECT_REF, sess: session });
  await popup.reload();
  await popup.waitForSelector("#rec");
  await popup.locator("#rec").click();
  await popup.waitForSelector("#stop");
  await popup.waitForTimeout(2000); // let the timer tick to a non-00:00 value
  await popup.screenshot({ path: path.join(OUT_DIR, "02-recording.png"), fullPage: false });

  // Stop without generating, so the next screenshot has a real recording in
  // the library.
  await popup.locator("#stop").click();
  await popup.waitForSelector("#gen", { timeout: 30_000 });
  await popup.screenshot({ path: path.join(OUT_DIR, "03-skill-view.png"), fullPage: false });

  await admin.auth.admin.deleteUser(userId);
  await context.close();
});
