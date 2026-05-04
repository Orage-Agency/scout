// Watchable end-to-end demo. Same flow as e2e.spec.ts but paced with slowMo
// so a human can follow along. The window stays open at the end so you can
// inspect the popup, the library, and the generated skill.
//
// Run: pnpm exec playwright test tests/demo.spec.ts --headed --reporter=list

import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

const EXT_DIR = path.resolve(__dirname, "../apps/extension/dist");
const USER_DATA_DIR = path.resolve(__dirname, ".chrome-profile-demo");
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

const TEST_EMAIL = `demo-${Date.now()}@scout-test.local`;
const TEST_PASSWORD = `Pass-${Date.now()}-Strong!`;

const STEP_PAUSE = 1200;

async function step(label: string, ms = STEP_PAUSE): Promise<void> {
  console.log(`\n>>> ${label}`);
  await new Promise((r) => setTimeout(r, ms));
}

test("watchable demo: full record -> skill flow", async () => {
  test.setTimeout(360_000);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  await step("creating test user");
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (cErr) throw cErr;
  const userId = created.user!.id;
  console.log(`    user ${TEST_EMAIL}`);

  await step("signing in to grab a session JWT");
  const userSb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signed, error: sErr } = await userSb.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (sErr) throw sErr;
  const session = signed.session!;

  await step("launching Chromium with the Scout extension preloaded");
  if (fs.existsSync(USER_DATA_DIR)) fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  const context: BrowserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    slowMo: 350,
    viewport: { width: 1280, height: 820 },
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  console.log(`    extension id ${extId}`);
  sw.on("console", (m) => console.log(`    [sw ${m.type()}] ${m.text()}`));

  await step("opening the Scout popup and injecting a real session");
  const popup = await context.newPage();
  popup.on("console", (m) => console.log(`    [popup ${m.type()}] ${m.text()}`));
  await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);
  await popup.evaluate(
    async ({ projectRef, sess }) => {
      await chrome.storage.local.set({
        [`sb-${projectRef}-auth-token`]: JSON.stringify(sess),
      });
    },
    { projectRef: PROJECT_REF, sess: session },
  );
  await popup.reload();
  await expect(popup.getByText(/Start Recording/i)).toBeVisible({ timeout: 15_000 });
  console.log(`    popup shows: signed in, idle`);

  await step("starting a tiny local site to record on");
  const fixtureHtml = `<!doctype html>
<html><body style="font:14px sans-serif;padding:32px;max-width:520px;background:#f9fafb;">
  <h1 style="margin:0 0 16px;">Customer triage queue</h1>
  <p>Pending refund request from <b>Alex Rivera</b> &mdash; order #4421, $128.00.</p>
  <button data-testid="approve" style="padding:8px 14px;margin-right:8px;">Approve refund</button>
  <button data-testid="escalate" style="padding:8px 14px;">Escalate to supervisor</button>
  <div style="margin-top:16px;">
    <label>Internal notes</label><br>
    <textarea data-testid="notes" rows="3" cols="60"></textarea>
  </div>
  <a href="/done" data-testid="done" style="display:inline-block;margin-top:16px;">Mark done</a>
</body></html>`;
  const doneHtml = `<!doctype html><html><body style="font:14px sans-serif;padding:32px;background:#ecfdf5;">
    <h1>Done</h1><p>Refund processed.</p></body></html>`;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(req.url === "/done" ? doneHtml : fixtureHtml);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const fixtureUrl = `http://127.0.0.1:${port}/`;
  const work = await context.newPage();
  await work.goto(fixtureUrl);

  await step("clicking Record in the popup");
  await popup.bringToFront();
  await popup.locator("#rec").click();
  await expect(popup.locator("#stop")).toBeVisible({ timeout: 10_000 });
  console.log(`    popup shows: Recording, with live counters`);

  await step("doing the actual workflow on the page");
  await work.bringToFront();
  await work.click("[data-testid=approve]");
  await work.waitForTimeout(800);
  await work.click("[data-testid=notes]");
  await work.locator("[data-testid=notes]").type(
    "Refund approved per the no-questions policy under $200.",
    { delay: 30 },
  );
  await work.waitForTimeout(800);
  await work.click("[data-testid=done]");
  await work.waitForLoadState("load").catch(() => undefined);
  await work.waitForTimeout(1500);

  await step("clicking Stop");
  await popup.bringToFront();
  await popup.locator("#stop").click();
  await expect(popup.locator("#gen")).toBeVisible({ timeout: 15_000 });

  await step("hitting Generate Skill (Claude via OpenRouter, ~30-60s)");
  await popup.locator("#gen").click();
  await expect(
    popup.getByText(/^## Steps/m).or(popup.getByText(/Steps/i)),
  ).toBeVisible({ timeout: 120_000 });

  const renderedText = await popup.locator("#app").innerText();
  console.log(`\n========== GENERATED SKILL (rendered) ==========\n${renderedText}\n========== END ==========\n`);

  await step("inspecting the database to prove what was captured");
  const { data: recRow } = await admin
    .from("recordings")
    .select("id,title,status,duration_ms,audio_path")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(1)
    .single();
  const { data: events } = await admin
    .from("events")
    .select("ts_ms,kind,screenshot_path")
    .eq("recording_id", recRow!.id);
  const eventsByKind = (events ?? []).reduce<Record<string, number>>((acc, e) => {
    acc[e.kind] = (acc[e.kind] ?? 0) + 1; return acc;
  }, {});
  const withShot = (events ?? []).filter((e) => e.screenshot_path).length;
  console.log(`\n[demo] capture summary:`);
  console.log(`  title:          ${recRow!.title ?? "(unset)"}`);
  console.log(`  status:         ${recRow!.status}`);
  console.log(`  duration:       ${recRow!.duration_ms}ms`);
  console.log(`  events total:   ${events?.length ?? 0}`);
  console.log(`  events by kind: ${JSON.stringify(eventsByKind)}`);
  console.log(`  events w/ shot: ${withShot}`);

  expect(recRow!.status).toBe("ready");
  expect(eventsByKind.click).toBeGreaterThan(0);
  expect(withShot).toBeGreaterThan(0);

  await step("leaving the window open for 30s so you can poke around", 30_000);

  await admin.auth.admin.deleteUser(userId);
  await context.close();
  await new Promise<void>((r) => server.close(() => r()));
});
