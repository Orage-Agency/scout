// Returning user — already signed in, just records. Measures the recurring
// friction (no signup step). This is what the user feels every workday.

import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

const EXT_DIR = path.resolve(__dirname, "../apps/extension/dist");
const PROFILE = path.resolve(__dirname, ".chrome-profile-returning");
const DOWNLOADS = path.resolve(__dirname, ".downloads-returning");
const AUDIO_FILE = path.resolve(__dirname, "fixtures/narration.wav");
const PROJECT_REF = "wmicxsafqbixedpjhchc";
const LOG = path.resolve(__dirname, "iteration-log.md");

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

const FIXTURE = `<!doctype html><body style="font:14px system-ui;padding:24px;">
<h2>Triage</h2><button data-testid="approve">Approve</button>
<button data-testid="done">Mark done</button></body>`;

test("returning user: 2-click flow (record + stop)", async () => {
  test.setTimeout(360_000);
  if (!fs.existsSync(DOWNLOADS)) fs.mkdirSync(DOWNLOADS, { recursive: true });
  if (fs.existsSync(PROFILE)) fs.rmSync(PROFILE, { recursive: true, force: true });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // Pre-create user.
  const email = `returning-${Date.now()}@scout-test.local`;
  const password = `Pass-${Date.now()}-Strong!`;
  const { data: user } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const userSb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signed } = await userSb.auth.signInWithPassword({ email, password });

  const server = http.createServer((_r, res) => { res.setHeader("content-type", "text/html"); res.end(FIXTURE); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const ctx: BrowserContext = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    slowMo: 150,
    viewport: { width: 1280, height: 820 },
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${AUDIO_FILE}`,
      "--no-first-run",
    ],
    permissions: ["microphone"],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;

  let clickCount = 0;
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);
  // Inject a real session — simulates "already signed in".
  await popup.evaluate(
    async ({ projectRef, sess }) => {
      await chrome.storage.local.set({ [`sb-${projectRef}-auth-token`]: JSON.stringify(sess) });
    },
    { projectRef: PROJECT_REF, sess: signed!.session },
  );
  await popup.reload();
  await popup.waitForTimeout(1500);
  await expect(popup.getByText(/Start Recording/i)).toBeVisible({ timeout: 15_000 });

  const work = await ctx.newPage();
  await work.goto(`http://127.0.0.1:${port}/`);

  const t0 = Date.now();
  await popup.bringToFront();
  clickCount++; console.log(`    click [${clickCount}] -> Record`);
  await popup.click("#rec");
  await expect(popup.locator("#stop")).toBeVisible({ timeout: 10_000 });

  await work.bringToFront();
  await work.click("[data-testid=approve]");
  await work.waitForTimeout(26_000);
  await work.click("[data-testid=done]");

  await popup.bringToFront();
  const dlPromise = popup.waitForEvent("download", { timeout: 180_000 });
  clickCount++; console.log(`    click [${clickCount}] -> Stop`);
  await popup.click("#stop");
  const dl = await dlPromise;
  const dlPath = path.join(DOWNLOADS, dl.suggestedFilename());
  await dl.saveAs(dlPath);
  const totalMs = Date.now() - t0;

  const summary = `| RETURN ${new Date().toISOString().slice(0, 19).replace("T", " ")} | ${clickCount} | ${(totalMs/1000).toFixed(1)}s | record->zip | ${dl.suggestedFilename()} |`;
  console.log(`\n[FRICTION] ${summary}`);
  fs.appendFileSync(LOG, summary + "\n");

  await admin.auth.admin.deleteUser(user.user!.id);
  await ctx.close();
  await new Promise<void>((r) => server.close(() => r()));
});
