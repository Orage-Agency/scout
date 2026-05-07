// Verifies the new email+password auth flow:
//   1. New user can sign up via the popup (no email confirmation needed —
//      mailer_autoconfirm is on at the project level).
//   2. Same email+password signs in cleanly on a second "device" (a fresh
//      Chromium profile), and that device sees the user's recordings.
//   3. A different email creates a separate account that CAN'T see the
//      first user's recordings (RLS).
//
// Run: pnpm exec playwright test tests/auth-multidevice.spec.ts --headed --reporter=list

import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import fs from "node:fs";
import { adminAuthClient, adminDataClient } from "./_helpers";

const EXT_DIR = path.resolve(__dirname, "../apps/extension/dist");

const envPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const TIMESTAMP = Date.now();
const USER_A_EMAIL = `auth-a-${TIMESTAMP}@scout-test.local`;
const USER_B_EMAIL = `auth-b-${TIMESTAMP}@scout-test.local`;
const PASSWORD = `Pass-${TIMESTAMP}-Strong!`;

async function openSignedOutPopup(profileDir: string): Promise<{ ctx: BrowserContext; popup: import("@playwright/test").Page; extId: string }> {
  if (fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    slowMo: 250,
    viewport: { width: 1280, height: 820 },
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  const popup = await ctx.newPage();
  popup.on("console", (m) => console.log(`[popup ${m.type()}] ${m.text()}`));
  await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);
  await expect(popup.locator("input[type=email]")).toBeVisible({ timeout: 10_000 });
  return { ctx, popup, extId };
}

test("email+password: signup, multi-device sign-in, RLS isolation", async () => {
  test.setTimeout(360_000);
  const admin = adminAuthClient();
  const adminData = adminDataClient();

  // ---------- Device 1: USER_A signs up ----------
  console.log(`\n[1/4] device 1 — USER_A signs up (${USER_A_EMAIL})`);
  const dev1Profile = path.resolve(__dirname, ".chrome-profile-dev1");
  const { ctx: ctx1, popup: popup1 } = await openSignedOutPopup(dev1Profile);
  await popup1.click("#alt"); // toggle to signup mode
  await popup1.fill("input[type=email]", USER_A_EMAIL);
  await popup1.fill("#pw", PASSWORD);
  await popup1.click("#go");
  await expect(popup1.getByText(/Start Recording/i)).toBeVisible({ timeout: 15_000 });
  console.log(`    ✓ signed up + auto-confirmed; landed on Start Recording`);

  // Insert a synthetic recording row for USER_A so we can later verify
  // device 2 sees it and USER_B doesn't. Since v0.1.4 split auth into a
  // separate project, look the user up via the auth admin API instead of
  // the data project's now-empty profiles table.
  const { data: usersList } = await admin.auth.admin.listUsers();
  const userA = usersList.users.find((u) => u.email === USER_A_EMAIL);
  if (!userA) throw new Error(`USER_A not found in auth project: ${USER_A_EMAIL}`);
  const { error: insErr } = await adminData.from("recordings").insert({
    user_id: userA.id,
    title: "Device-1 marker recording",
    status: "ready",
  });
  if (insErr) throw insErr;
  console.log(`    ✓ marker recording inserted for USER_A`);
  await ctx1.close();

  // ---------- Device 2: USER_A signs in on a fresh profile ----------
  console.log(`\n[2/4] device 2 — USER_A signs in on fresh profile`);
  const dev2Profile = path.resolve(__dirname, ".chrome-profile-dev2");
  const { ctx: ctx2, popup: popup2 } = await openSignedOutPopup(dev2Profile);
  await popup2.fill("input[type=email]", USER_A_EMAIL);
  await popup2.fill("#pw", PASSWORD);
  await popup2.click("#go");
  await expect(popup2.getByText(/Start Recording/i)).toBeVisible({ timeout: 15_000 });
  // Library tab should show the marker recording.
  await popup2.getByRole("button", { name: /^Library$/i }).click();
  await expect(popup2.getByText("Device-1 marker recording")).toBeVisible({ timeout: 10_000 });
  console.log(`    ✓ device 2 sees USER_A's recording — multi-device works`);
  await ctx2.close();

  // ---------- Device 3: USER_B signs up — must NOT see USER_A's data ----------
  console.log(`\n[3/4] device 3 — USER_B signs up (${USER_B_EMAIL})`);
  const dev3Profile = path.resolve(__dirname, ".chrome-profile-dev3");
  const { ctx: ctx3, popup: popup3 } = await openSignedOutPopup(dev3Profile);
  await popup3.click("#alt");
  await popup3.fill("input[type=email]", USER_B_EMAIL);
  await popup3.fill("#pw", PASSWORD);
  await popup3.click("#go");
  await expect(popup3.getByText(/Start Recording/i)).toBeVisible({ timeout: 15_000 });
  await popup3.getByRole("button", { name: /^Library$/i }).click();
  await expect(popup3.getByText(/No recordings yet/i)).toBeVisible({ timeout: 10_000 });
  console.log(`    ✓ USER_B's library is empty — RLS isolates accounts`);
  await ctx3.close();

  // ---------- Cleanup ----------
  console.log(`\n[4/4] cleanup`);
  const { data: usersList2 } = await admin.auth.admin.listUsers();
  const userB = usersList2.users.find((u) => u.email === USER_B_EMAIL);
  await admin.auth.admin.deleteUser(userA.id);
  if (userB) await admin.auth.admin.deleteUser(userB.id);
  console.log(`    ✓ test users deleted`);
});
