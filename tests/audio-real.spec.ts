// True audio test. Chromium reads tests/fixtures/narration.wav as a fake
// microphone (--use-file-for-fake-audio-capture) so the offscreen
// MediaRecorder gets real audio instead of silence. We then verify:
//   - recordings.audio_path is set (audio uploaded to Supabase Storage)
//   - recordings.transcript.segments is populated (Gemini transcribed it)
//   - the transcript text contains a key phrase from the narration
//   - the generated SKILL.md reflects the rationale the user spoke
//
// Run: pnpm exec playwright test tests/audio-real.spec.ts --headed --reporter=list

import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

const EXT_DIR = path.resolve(__dirname, "../apps/extension/dist");
const USER_DATA_DIR = path.resolve(__dirname, ".chrome-profile-audio");
const AUDIO_FILE = path.resolve(__dirname, "fixtures/narration.wav");
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

const TEST_EMAIL = `audio-${Date.now()}@scout-test.local`;
const TEST_PASSWORD = `Pass-${Date.now()}-Strong!`;

async function step(label: string, ms = 800): Promise<void> {
  console.log(`\n>>> ${label}`);
  await new Promise((r) => setTimeout(r, ms));
}

const FIXTURE_HTML = `<!doctype html><html><body style="font:14px sans-serif;padding:32px;background:#f9fafb;">
<h1>Triage queue</h1>
<div style="background:#fff;border:1px solid #e5e7eb;padding:16px 20px;margin:0 0 12px;border-radius:6px;">
  <div><b>#A101</b> · Maria Santos · $147.00 · "wrong size"</div>
  <button data-testid="approve-A101" style="margin-top:10px;padding:6px 12px;">Approve refund</button>
  <button data-testid="done-A101" style="margin-top:10px;padding:6px 12px;">Mark done</button>
</div>
</body></html>`;

test("real audio: narration -> transcript -> skill", async () => {
  test.setTimeout(360_000);
  if (!fs.existsSync(AUDIO_FILE)) throw new Error(`audio fixture missing at ${AUDIO_FILE}`);

  const admin = adminAuthClient();

  await step("creating test user");
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (cErr) throw cErr;
  const userId = created.user!.id;

  const userSb = userAuthClient();
  const { data: signed } = await userSb.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  const session = signed!.session!;

  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(FIXTURE_HTML);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  await step("launching Chromium with fake mic streaming narration.wav");
  if (fs.existsSync(USER_DATA_DIR)) fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  const ctx: BrowserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    slowMo: 250,
    viewport: { width: 1280, height: 820 },
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
  await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);
  await popup.evaluate(
    async ({ projectRef, sess }) => {
      await chrome.storage.local.set({ [`sb-${projectRef}-auth-token`]: JSON.stringify(sess) });
    },
    { projectRef: PROJECT_REF, sess: session },
  );
  await popup.reload();
  await expect(popup.getByText(/Start Recording/i)).toBeVisible({ timeout: 15_000 });

  const work = await ctx.newPage();
  await work.goto(`http://127.0.0.1:${port}/`);

  await step("starting recording (mic should auto-grant)");
  await popup.bringToFront();
  await popup.locator("#rec").click();
  await expect(popup.locator("#stop")).toBeVisible({ timeout: 10_000 });

  await step("simulating workflow while narration plays into the fake mic");
  await work.bringToFront();
  await work.click("[data-testid=approve-A101]");
  // Let the narration play (~25s) so the audio recorder captures real speech.
  await work.waitForTimeout(28_000);
  await work.click("[data-testid=done-A101]");
  await work.waitForTimeout(2_000);

  await step("clicking Stop and waiting for transcribe -> ready");
  await popup.bringToFront();
  await popup.locator("#stop").click();
  // Stop kicks off transcribe. Wait until the recording flips to ready.
  let recRow: { id: string; status: string; audio_path: string | null; transcript: { segments: Array<{ text: string }> } | null; duration_ms: number } | null = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const { data } = await admin
      .from("recordings")
      .select("id,status,audio_path,transcript,duration_ms")
      .eq("user_id", userId)
      .order("started_at", { ascending: false })
      .limit(1)
      .single();
    if (data) recRow = data as typeof recRow;
    if (recRow?.status === "ready" || recRow?.status === "failed") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!recRow) throw new Error("recording never appeared");
  console.log(`\n[audio] recording duration: ${recRow.duration_ms}ms`);
  console.log(`[audio] status:             ${recRow.status}`);
  console.log(`[audio] audio_path:         ${recRow.audio_path ?? "(none)"}`);
  const segs = recRow.transcript?.segments ?? [];
  console.log(`[audio] transcript segs:    ${segs.length}`);
  for (const s of segs) console.log(`    "${s.text}"`);

  expect(recRow.status).toBe("ready");
  expect(recRow.audio_path).toBeTruthy();
  expect(segs.length).toBeGreaterThan(0);
  const transcriptText = segs.map((s) => s.text).join(" ").toLowerCase();
  // narration mentioned "policy" and "approve" — at least one should land
  // even allowing for ASR sloppiness on the SAPI voice.
  expect(transcriptText).toMatch(/policy|approve|refund|two hundred|threshold/);

  await step("generating skill (transcript should influence content)");
  await expect(popup.locator("#gen")).toBeVisible({ timeout: 15_000 });
  await popup.locator("#gen").click();
  await expect(popup.getByText(/Steps/i)).toBeVisible({ timeout: 180_000 });

  const renderedText = await popup.locator("#app").innerText();
  console.log(`\n========== GENERATED SKILL ==========\n${renderedText}\n========== END ==========\n`);

  // Sanity: the SKILL.md should now reference at least one rationale-y
  // word that came from the narration (under v0.1.x with no narration the
  // skill couldn't say *why* — it only had click events to work with).
  const lower = renderedText.toLowerCase();
  expect(lower).toMatch(/policy|under \$200|under two hundred|no fraud|wrong size/);

  await step("leaving open 10s", 10_000);

  await admin.auth.admin.deleteUser(userId);
  await ctx.close();
  await new Promise<void>((r) => server.close(() => r()));
});
