// Drives the real OTP sign-in flow against Supabase. The popup hits the
// real signInWithOtp endpoint; the test then polls a temp file for the
// 6-digit code (an external orchestrator fetches it from Gmail and writes
// it). Finally it verifies the OTP and asserts the popup reaches the
// signed-in idle state.
//
// Run: pnpm exec playwright test tests/real-otp.spec.ts --headed --reporter=list

import { test, expect, chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const EXT_DIR = path.resolve(__dirname, "../apps/extension/dist");
const USER_DATA_DIR = path.resolve(__dirname, ".chrome-profile-realotp");
const OTP_FILE = path.resolve(__dirname, ".otp.txt");
const TEST_EMAIL = "georgemoffat@orage.agency";

test("real OTP sign-in via team@orage.agency", async () => {
  test.setTimeout(180_000);

  if (fs.existsSync(USER_DATA_DIR)) fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  if (fs.existsSync(OTP_FILE)) fs.unlinkSync(OTP_FILE);

  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    slowMo: 200,
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
  popup.on("pageerror", (e) => console.log(`[popup pageerror] ${e.message}`));
  await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);

  // Step 1: enter email and trigger OTP.
  await popup.fill("input[type=email]", TEST_EMAIL);
  await popup.click("#send");
  console.log(`[real-otp] OTP triggered for ${TEST_EMAIL}`);

  // Step 2: confirm we landed on the magic_sent view (proves Supabase accepted the call).
  await expect(popup.getByText(/Check your inbox/i)).toBeVisible({ timeout: 15_000 });
  console.log(`[real-otp] popup shows 'Check your inbox'`);

  // Step 3: poll for the OTP code written by the orchestrator.
  console.log(`[real-otp] waiting for ${OTP_FILE}`);
  let code: string | null = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(OTP_FILE)) {
      const raw = fs.readFileSync(OTP_FILE, "utf8").trim();
      if (/^[0-9A-Za-z]{6,10}$/.test(raw)) {
        code = raw;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!code) throw new Error(`OTP file never appeared at ${OTP_FILE}`);
  console.log(`[real-otp] got code ${code}`);

  // Step 4: paste and verify.
  await popup.fill("#code", code);
  await popup.click("#verify");

  // Step 5: assert idle state.
  await expect(popup.getByText(/Start Recording/i)).toBeVisible({ timeout: 15_000 });
  console.log(`[real-otp] signed in successfully — popup is at idle state.`);

  await new Promise((r) => setTimeout(r, 4000));
  await ctx.close();
  if (fs.existsSync(OTP_FILE)) fs.unlinkSync(OTP_FILE);
});
