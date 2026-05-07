// End-to-end test of the redesigned v0.1.2 build. Drives a real signup
// through the new popup, records with audio narration playing, generates
// a skill, downloads the Claude Code skill zip, and verifies everything.
//
// Run: pnpm exec playwright test tests/full-flow-v012.spec.ts --headed --reporter=list

import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

const EXT_DIR = path.resolve(__dirname, "../apps/extension/dist");
const USER_DATA_DIR = path.resolve(__dirname, ".chrome-profile-fullflow");
const DOWNLOAD_DIR = path.resolve(__dirname, ".downloads-fullflow");
const AUDIO_FILE = path.resolve(__dirname, "fixtures/narration.wav");
const SCREENSHOTS = path.resolve(__dirname, "screenshots");

const envPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const TEST_EMAIL = `fullflow-${Date.now()}@scout-test.local`;
const PASSWORD = `Scout-${Date.now()}-Strong!`;

async function step(label: string, ms = 800): Promise<void> {
  console.log(`\n>>> ${label}`);
  await new Promise((r) => setTimeout(r, ms));
}

const FIXTURE_HTML = `<!doctype html><html><head><title>Triage queue</title>
<style>body{font:14px/1.4 system-ui;margin:0;background:#f9fafb;color:#0f172a;}
.bar{background:#0f172a;color:#f1f5f9;padding:12px 24px;font-weight:600;}
main{padding:32px;max-width:680px;}
h1{margin:0 0 16px;}
.card{background:#fff;border:1px solid #e5e7eb;padding:16px 20px;margin:0 0 12px;border-radius:6px;}
button{padding:8px 14px;border:1px solid #cbd5e1;background:#fff;border-radius:4px;cursor:pointer;font:inherit;}
button.primary{background:#16a34a;color:#fff;border-color:#16a34a;}</style></head>
<body><div class="bar">Orage CRM</div><main>
  <h1>Triage queue</h1>
  <div class="card">
    <div><b>#A101</b> · Maria Santos · $147.00 · "wrong size"</div>
    <button data-testid="approve-A101" class="primary" style="margin-top:10px;">Approve refund</button>
    <button data-testid="done-A101" style="margin-top:10px;">Mark done</button>
  </div>
</main></body></html>`;

test("v0.1.2 full flow: redesigned signup + audio recording + skill download", async () => {
  test.setTimeout(420_000);
  if (!fs.existsSync(AUDIO_FILE)) throw new Error(`audio fixture missing at ${AUDIO_FILE}`);
  if (!fs.existsSync(SCREENSHOTS)) fs.mkdirSync(SCREENSHOTS, { recursive: true });
  if (fs.existsSync(USER_DATA_DIR)) fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  if (fs.existsSync(DOWNLOAD_DIR)) fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const admin = adminAuthClient();

  // Local fixture server
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(FIXTURE_HTML);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  await step("launching Chromium with extension + fake mic + downloads to temp dir");
  const ctx: BrowserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    slowMo: 200,
    viewport: { width: 1280, height: 820 },
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${AUDIO_FILE}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    permissions: ["microphone"],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  sw.on("console", (m) => console.log(`    [sw ${m.type()}] ${m.text()}`));

  const popup = await ctx.newPage();
  popup.on("console", (m) => console.log(`    [popup ${m.type()}] ${m.text()}`));
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);
  await popup.waitForTimeout(1500); // let webfonts load

  await step("signing up via the redesigned popup");
  await popup.click("#alt"); // toggle to signup mode
  await popup.fill("input[type=email]", TEST_EMAIL);
  await popup.fill("#pw", PASSWORD);
  await popup.screenshot({ path: path.join(SCREENSHOTS, "v012-01-signup-filled.png") });
  await popup.click("#go");
  await expect(popup.getByText(/Start Recording/i)).toBeVisible({ timeout: 15_000 });
  await popup.screenshot({ path: path.join(SCREENSHOTS, "v012-02-idle-record.png") });
  console.log(`    ✓ signed up + landed on Start Recording`);

  await step("opening fixture page");
  const work = await ctx.newPage();
  await work.goto(`http://127.0.0.1:${port}/`);
  await work.waitForLoadState("load");

  await step("clicking Record — narration begins streaming through fake mic");
  await popup.bringToFront();
  await popup.locator("#rec").click();
  await expect(popup.locator("#stop")).toBeVisible({ timeout: 10_000 });
  await popup.screenshot({ path: path.join(SCREENSHOTS, "v012-03-recording.png") });

  await step("doing the workflow while narration plays");
  await work.bringToFront();
  await work.click("[data-testid=approve-A101]");
  await work.waitForTimeout(28_000); // let the 25s narration play through
  await work.click("[data-testid=done-A101]");
  await work.waitForTimeout(1500);

  await step("clicking Stop");
  await popup.bringToFront();
  await popup.locator("#stop").click();
  await expect(popup.locator("#gen")).toBeVisible({ timeout: 15_000 });
  await popup.screenshot({ path: path.join(SCREENSHOTS, "v012-04-after-stop.png") });

  await step("waiting for transcribe -> ready");
  let recRow: { id: string; status: string; audio_path: string | null; transcript: { segments?: Array<{ text: string }> } | null; duration_ms: number } | null = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const { data: list } = await admin.auth.admin.listUsers();
    const u = list.users.find((x) => x.email === TEST_EMAIL);
    if (u) {
      const { data } = await admin
        .from("recordings")
        .select("id,status,audio_path,transcript,duration_ms")
        .eq("user_id", u.id)
        .order("started_at", { ascending: false })
        .limit(1)
        .single();
      if (data) recRow = data as typeof recRow;
      if (recRow?.status === "ready" || recRow?.status === "failed") break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`\n[v012] capture summary:`);
  console.log(`  duration:   ${recRow?.duration_ms}ms`);
  console.log(`  status:     ${recRow?.status}`);
  console.log(`  audio_path: ${recRow?.audio_path ?? "(none)"}`);
  const segs = recRow?.transcript?.segments ?? [];
  console.log(`  transcript segments: ${segs.length}`);
  expect(recRow?.status).toBe("ready");
  expect(recRow?.audio_path).toBeTruthy();
  expect(segs.length).toBeGreaterThan(0);

  await step("generating skill");
  await popup.locator("#gen").click();
  await expect(popup.getByText(/Steps/i)).toBeVisible({ timeout: 180_000 });
  await popup.screenshot({ path: path.join(SCREENSHOTS, "v012-05-skill-view.png"), fullPage: true });

  await step("downloading the Claude Code skill zip");
  const downloadPromise = popup.waitForEvent("download");
  await popup.locator("#claude").click();
  const dl = await downloadPromise;
  const dlPath = path.join(DOWNLOAD_DIR, dl.suggestedFilename());
  await dl.saveAs(dlPath);
  console.log(`    ✓ downloaded ${dl.suggestedFilename()} -> ${dlPath}`);
  expect(fs.existsSync(dlPath)).toBe(true);
  expect(fs.statSync(dlPath).size).toBeGreaterThan(500); // not empty

  // Inspect the zip via Node — confirm it has <slug>/SKILL.md
  const fflate = await import("fflate");
  const buf = fs.readFileSync(dlPath);
  const entries = fflate.unzipSync(buf);
  const names = Object.keys(entries);
  console.log(`    zip contents: ${names.join(", ")}`);
  const skillEntry = names.find((n) => n.endsWith("/SKILL.md"));
  expect(skillEntry).toBeTruthy();
  const skillContent = new TextDecoder().decode(entries[skillEntry!]);
  expect(skillContent).toMatch(/^---/);
  expect(skillContent).toMatch(/name:/);
  expect(skillContent).toMatch(/## Steps/i);

  await step("leaving open 15s so you can poke around", 15_000);

  // Cleanup
  const { data: list } = await admin.auth.admin.listUsers();
  const u = list.users.find((x) => x.email === TEST_EMAIL);
  if (u) await admin.auth.admin.deleteUser(u.id);
  await ctx.close();
  await new Promise<void>((r) => server.close(() => r()));
});
