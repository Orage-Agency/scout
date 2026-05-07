// Visual snapshot of the redesigned popup. Captures each major view to
// tests/screenshots/ so we can eyeball that the brand redesign actually
// renders the way it's supposed to.

import { test, expect, chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { adminAuthClient, adminDataClient, userAuthClient } from "./_helpers";
import path from "node:path";
import fs from "node:fs";

const EXT_DIR = path.resolve(__dirname, "../apps/extension/dist");
const USER_DATA_DIR = path.resolve(__dirname, ".chrome-profile-visual");
const SCREENSHOTS = path.resolve(__dirname, "screenshots");
const PROJECT_REF = "wmicxsafqbixedpjhchc";

const envPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

test("visual snapshot: every popup state", async () => {
  test.setTimeout(120_000);
  if (!fs.existsSync(SCREENSHOTS)) fs.mkdirSync(SCREENSHOTS, { recursive: true });
  if (fs.existsSync(USER_DATA_DIR)) fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 820 },
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--no-first-run",
    ],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;

  const popup = await ctx.newPage();
  popup.on("console", (m) => console.log(`[popup ${m.type()}] ${m.text()}`));
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);
  // Let webfonts load.
  await popup.waitForTimeout(2000);
  await popup.screenshot({ path: path.join(SCREENSHOTS, "01-signed-out.png"), fullPage: true });

  // Toggle to signup.
  await popup.click("#alt");
  await popup.waitForTimeout(300);
  await popup.screenshot({ path: path.join(SCREENSHOTS, "02-signup.png"), fullPage: true });

  // Inject a real session so we can see the signed-in views.
  const admin = adminAuthClient();
  const adminData = adminDataClient();
  const email = `visual-${Date.now()}@scout-test.local`;
  const password = `Pass-${Date.now()}-Strong!`;
  const { data: user } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const userSb = userAuthClient();
  const { data: signed } = await userSb.auth.signInWithPassword({ email, password });
  await popup.evaluate(
    async ({ projectRef, sess }) => {
      await chrome.storage.local.set({ [`sb-${projectRef}-auth-token`]: JSON.stringify(sess) });
    },
    { projectRef: PROJECT_REF, sess: signed!.session },
  );

  // Insert a sample recording so the library has something to show.
  await adminData.from("recordings").insert({
    user_id: user.user!.id,
    title: "Approve Small Refund",
    status: "ready",
    duration_ms: 65000,
    audio_path: `${user.user!.id}/sample.webm`,
  });
  const { data: recRow } = await adminData
    .from("recordings")
    .select("id")
    .eq("user_id", user.user!.id)
    .single();
  await adminData.from("skills").insert({
    recording_id: recRow!.id,
    user_id: user.user!.id,
    version: 1,
    title: "Approve Small Refund",
    body_md: `---\nname: approve-small-refund\nversion: 1\ndescription: Approve a refund under $200 using the no-questions policy.\n---\n\n# Approve Small Refund\n\n## Goal\nProcess and approve customer refund requests under $200.\n\n## Steps\n1. Open the ticket from the queue.\n2. Verify the amount is under $200.\n3. Click **Approve refund** and document the reason.`,
  });

  await popup.reload();
  await popup.waitForTimeout(800);
  await popup.screenshot({ path: path.join(SCREENSHOTS, "03-idle-record.png"), fullPage: true });

  // Click Library tab.
  await popup.locator(".tab-pill").nth(1).click();
  await popup.waitForTimeout(800);
  await popup.screenshot({ path: path.join(SCREENSHOTS, "04-library.png"), fullPage: true });

  // Click into the recording to see the skill view.
  await popup.locator("button.glass").first().click();
  await popup.waitForTimeout(500);
  await popup.screenshot({ path: path.join(SCREENSHOTS, "05-skill-view.png"), fullPage: true });

  // Settings tab.
  await popup.goBack().catch(() => undefined);
  await popup.evaluate(() => location.reload());
  await popup.waitForTimeout(600);
  await popup.locator(".tab-pill").nth(2).click();
  await popup.waitForTimeout(400);
  await popup.screenshot({ path: path.join(SCREENSHOTS, "06-settings.png"), fullPage: true });

  // Cleanup.
  await admin.auth.admin.deleteUser(user.user!.id);
  await ctx.close();

  console.log("\nScreenshots written to:", SCREENSHOTS);
  expect(fs.readdirSync(SCREENSHOTS).filter((f) => f.startsWith("0")).length).toBeGreaterThanOrEqual(5);
});
