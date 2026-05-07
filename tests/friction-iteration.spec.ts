// Friction iteration harness. Runs the full flow as a fresh user, measures:
//   - clicks the user has to make from "popup open" to "zip downloaded"
//   - wall-clock time for each phase
//   - any errors / unexpected states
// Writes a one-line summary to tests/iteration-log.md so we can compare runs.
//
// Run: pnpm exec playwright test tests/friction-iteration.spec.ts --headed --reporter=list

import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

const EXT_DIR = path.resolve(__dirname, "../apps/extension/dist");
const PROFILE = path.resolve(__dirname, ".chrome-profile-friction");
const DOWNLOADS = path.resolve(__dirname, ".downloads-friction");
const AUDIO_FILE = path.resolve(__dirname, "fixtures/narration.wav");
const LOG = path.resolve(__dirname, "iteration-log.md");

const envPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const FIXTURE = `<!doctype html><html><head><title>Triage</title>
<style>body{font:14px system-ui;margin:0;background:#f9fafb;color:#0f172a;}
.bar{background:#0f172a;color:#f1f5f9;padding:12px 24px;}
main{padding:24px;max-width:560px;}
button{padding:8px 14px;border:1px solid #cbd5e1;border-radius:4px;cursor:pointer;font:inherit;margin-right:6px;}
button.primary{background:#16a34a;color:#fff;border-color:#16a34a;}</style></head>
<body><div class="bar">Orage CRM</div><main>
<h2>Refund #A101 · Maria Santos · $147 · "wrong size"</h2>
<button data-testid="approve" class="primary">Approve refund</button>
<button data-testid="done">Mark done</button>
</main></body></html>`;

function appendLog(line: string): void {
  if (!fs.existsSync(LOG)) {
    fs.writeFileSync(LOG, "# Iteration Log\n\n| # | Date | Clicks | Total time | Phase times | Notes |\n|---|------|--------|------------|-------------|-------|\n");
  }
  fs.appendFileSync(LOG, line + "\n");
}

test("friction iteration", async () => {
  test.setTimeout(360_000);
  if (!fs.existsSync(DOWNLOADS)) fs.mkdirSync(DOWNLOADS, { recursive: true });
  if (fs.existsSync(PROFILE)) fs.rmSync(PROFILE, { recursive: true, force: true });

  const admin = adminAuthClient();

  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(FIXTURE);
  });
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

  // Click counter — instrument every popup click.
  let clickCount = 0;
  const popup = await ctx.newPage();
  popup.on("console", (m) => {
    if (m.type() === "warning" || m.type() === "error") console.log(`    [popup ${m.type()}] ${m.text()}`);
  });
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);
  await popup.waitForTimeout(1500);

  const trackedClick = async (selector: string, label: string) => {
    clickCount += 1;
    console.log(`    click [${clickCount}] -> ${label}`);
    await popup.click(selector);
  };

  const t0 = Date.now();
  const phaseTimes: Record<string, number> = {};
  const mark = (phase: string) => { phaseTimes[phase] = Date.now() - t0; };

  // --- Sign up (unified — no signin/signup toggle) ---
  const email = `friction-${Date.now()}@scout-test.local`;
  const password = `Pass-${Date.now()}-Strong!`;
  await popup.fill("input[type=email]", email);
  await popup.fill("#pw", password);
  await trackedClick("#go", "Continue");
  await expect(popup.getByText(/Start Recording/i)).toBeVisible({ timeout: 20_000 });
  mark("signup");

  // --- Open work tab ---
  const work = await ctx.newPage();
  await work.goto(`http://127.0.0.1:${port}/`);
  await work.waitForLoadState("load");

  // --- Record ---
  await popup.bringToFront();
  await trackedClick("#rec", "Record");
  await expect(popup.locator("#stop")).toBeVisible({ timeout: 10_000 });
  mark("record_started");

  // --- Do work + narrate ---
  await work.bringToFront();
  await work.click("[data-testid=approve]");
  await work.waitForTimeout(26_000);
  await work.click("[data-testid=done]");
  await work.waitForTimeout(1500);

  // --- Stop ---
  await popup.bringToFront();
  // Attach the download listener BEFORE Stop because auto-download fires
  // somewhere between Stop and the skill-ready transition. We don't need
  // a separate "click Save" step anymore — if auto-download works, this
  // download event arrives without any user click.
  const dlPromise = popup.waitForEvent("download", { timeout: 180_000 });
  await trackedClick("#stop", "Stop");

  const dl = await dlPromise;
  const dlPath = path.join(DOWNLOADS, dl.suggestedFilename());
  await dl.saveAs(dlPath);
  mark("zip_downloaded");

  // Confirmation banner should be visible by now.
  const bannerVisible = await popup.getByText(/Saved to Downloads/i).isVisible().catch(() => false);
  console.log(`    saved-banner visible: ${bannerVisible}`);
  // The skill view itself should be on screen (verifies kind="skill").
  const claudeBtnPresent = await popup.locator("#claude").isVisible().catch(() => false);
  expect(claudeBtnPresent).toBe(true);
  mark("skill_ready");

  const totalMs = Date.now() - t0;
  const summary = `| ${new Date().toISOString().slice(0, 19).replace("T", " ")} | ${clickCount} | ${(totalMs/1000).toFixed(1)}s | signup=${(phaseTimes.signup/1000).toFixed(1)}s · record=${(phaseTimes.record_started/1000).toFixed(1)}s · stop->skill=${((phaseTimes.skill_ready - phaseTimes.record_started)/1000).toFixed(1)}s · skill->zip=${((phaseTimes.zip_downloaded - phaseTimes.skill_ready)/1000).toFixed(1)}s | ${dl.suggestedFilename()} |`;
  console.log(`\n[FRICTION] ${summary}`);
  appendLog(summary);

  // Cleanup
  const { data: list } = await admin.auth.admin.listUsers();
  const u = list.users.find((x) => x.email === email);
  if (u) await admin.auth.admin.deleteUser(u.id);
  await ctx.close();
  await new Promise<void>((r) => server.close(() => r()));
});
