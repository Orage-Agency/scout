// Verifies that closing the popup mid-flow doesn't break recovery: user
// clicks Stop, immediately closes the popup, reopens it later, sees either
// the processing view (resumed) or the skill view (already done).

import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

const EXT_DIR = path.resolve(__dirname, "../apps/extension/dist");
const PROFILE = path.resolve(__dirname, ".chrome-profile-recovery");
const AUDIO_FILE = path.resolve(__dirname, "fixtures/narration.wav");

const envPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const FIXTURE = `<!doctype html><body style="font:14px system-ui;padding:24px;">
<h2>Triage</h2><button data-testid="approve">Approve</button>
<button data-testid="done">Mark done</button></body>`;

test("popup recovery: close mid-wait + reopen lands on skill", async () => {
  test.setTimeout(360_000);
  if (fs.existsSync(PROFILE)) fs.rmSync(PROFILE, { recursive: true, force: true });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const server = http.createServer((_r, res) => { res.setHeader("content-type", "text/html"); res.end(FIXTURE); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const ctx: BrowserContext = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    slowMo: 150,
    viewport: { width: 1280, height: 820 },
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
  const popupUrl = `chrome-extension://${extId}/src/popup/index.html`;

  // Sign up.
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(popupUrl);
  await popup.waitForTimeout(1000);
  const email = `recovery-${Date.now()}@scout-test.local`;
  const password = `Pass-${Date.now()}-Strong!`;
  await popup.fill("input[type=email]", email);
  await popup.fill("#pw", password);
  await popup.click("#go");
  await expect(popup.getByText(/Start Recording/i)).toBeVisible({ timeout: 20_000 });

  // Open work tab + record.
  const work = await ctx.newPage();
  await work.goto(`http://127.0.0.1:${port}/`);
  await popup.bringToFront();
  await popup.click("#rec");
  await expect(popup.locator("#stop")).toBeVisible({ timeout: 10_000 });

  // Some events.
  await work.bringToFront();
  await work.click("[data-testid=approve]");
  await work.waitForTimeout(20_000);
  await work.click("[data-testid=done]");

  // Stop.
  await popup.bringToFront();
  await popup.click("#stop");

  // Verify processing view appeared, then close the popup tab (simulates
  // the user clicking outside the action popup in real Chrome).
  await expect(popup.getByText(/Finishing up/i)).toBeVisible({ timeout: 5_000 });
  console.log("    ✓ processing view shown");
  await popup.close();
  console.log("    popup closed mid-wait");

  // Wait long enough for the skill to finish in the background.
  await new Promise((r) => setTimeout(r, 60_000));

  // Re-open the popup — should land on the skill view directly.
  const popup2 = await ctx.newPage();
  await popup2.setViewportSize({ width: 380, height: 600 });
  await popup2.goto(popupUrl);
  await popup2.waitForTimeout(2000);
  const onSkillView = await popup2.locator("#claude").isVisible().catch(() => false);
  console.log(`    re-opened popup, on skill view: ${onSkillView}`);
  expect(onSkillView).toBe(true);

  // Cleanup.
  const { data: list } = await admin.auth.admin.listUsers();
  const u = list.users.find((x) => x.email === email);
  if (u) await admin.auth.admin.deleteUser(u.id);
  await ctx.close();
  await new Promise<void>((r) => server.close(() => r()));
});
