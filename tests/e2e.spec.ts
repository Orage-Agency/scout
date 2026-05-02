// Real end-to-end: programmatically create a Supabase user via the admin API,
// inject the resulting session into the extension's localStorage, drive the
// popup through Record → simulated workflow → Stop → Generate Skill, and
// print the produced SKILL.md. Cleans up the test user at the end.
//
// Hits real Supabase + real OpenRouter — costs a few cents per run.
//
// Run with: pnpm exec playwright test tests/e2e.spec.ts --reporter=list

import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

const EXT_DIR = path.resolve(__dirname, "../apps/extension/dist");
const USER_DATA_DIR = path.resolve(__dirname, ".chrome-profile-e2e");
const PROJECT_REF = "wmicxsafqbixedpjhchc";

// Load .env from repo root (Vite's envDir lives there too).
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

const TEST_EMAIL = `e2e-${Date.now()}@scout-test.local`;
const TEST_PASSWORD = `Pass-${Date.now()}-Strong!`;

test("end-to-end: sign in, record, generate skill", async () => {
  test.setTimeout(240_000);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Create test user with auto-confirmed email.
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (cErr) throw cErr;
  const userId = created.user!.id;
  console.log(`[e2e] created user ${TEST_EMAIL} (${userId})`);

  // 2. Sign in as that user to grab a real session JWT.
  const userSb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signed, error: sErr } = await userSb.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (sErr) throw sErr;
  const session = signed.session!;
  console.log(`[e2e] got session, expires ${new Date(session.expires_at! * 1000).toISOString()}`);

  // 3. Launch Chromium with the Scout extension preloaded.
  // Using a fresh profile so we can inject the session cleanly.
  if (fs.existsSync(USER_DATA_DIR)) fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  const context: BrowserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
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
  console.log(`[e2e] extension id ${extId}`);

  // Mirror service-worker console output into the test log so we can see
  // what the background is doing (audio finalize, transcribe trigger, etc).
  sw.on("console", (m) => console.log(`[sw ${m.type()}] ${m.text()}`));

  // 4. Open popup, inject the session into localStorage, reload.
  const popup = await context.newPage();
  popup.on("console", (m) => console.log(`[popup ${m.type()}] ${m.text()}`));
  popup.on("pageerror", (e) => console.log(`[popup pageerror] ${e.message}`));
  popup.on("requestfailed", (req) => console.log(`[popup reqfail] ${req.url()} (${req.failure()?.errorText})`));
  await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);

  // The popup uses chrome.storage.local via a custom adapter (see
  // apps/extension/src/lib/supabase.ts). Supabase v2 stores the session as
  // a JSON string under `sb-<ref>-auth-token`.
  await popup.evaluate(async ({ projectRef, sess }) => {
    const storageKey = `sb-${projectRef}-auth-token`;
    await chrome.storage.local.set({ [storageKey]: JSON.stringify(sess) });
  }, { projectRef: PROJECT_REF, sess: session });

  await popup.reload();

  // 5. Confirm popup shows the signed-in idle state (Start Recording button).
  await expect(popup.getByText(/Start Recording/i)).toBeVisible({ timeout: 15_000 });
  console.log(`[e2e] popup signed in, idle`);

  // 6. Spin up a tiny local HTTP server so the workflow page is served on
  // an http://127.0.0.1 origin — content_scripts don't inject into data:
  // URLs (Chrome scheme restriction), so capture would be empty there.
  const fixtureHtml = `<!doctype html>
<html><body style="font:14px sans-serif;padding:32px;max-width:520px;">
  <h1 style="margin:0 0 16px;">Customer triage queue</h1>
  <p>Pending refund request from <b>Alex Rivera</b> — order #4421, $128.00.</p>
  <button data-testid="approve" style="padding:8px 14px;margin-right:8px;">Approve refund</button>
  <button data-testid="escalate" style="padding:8px 14px;">Escalate to supervisor</button>
  <div style="margin-top:16px;">
    <label>Internal notes</label><br>
    <textarea data-testid="notes" rows="3" cols="60"></textarea>
  </div>
  <a href="/done" data-testid="done" style="display:inline-block;margin-top:16px;">Mark done</a>
</body></html>`;
  const doneHtml = `<!doctype html><html><body style="font:14px sans-serif;padding:32px;">
    <h1>Done</h1><p>Refund processed.</p></body></html>`;

  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(req.url === "/done" ? doneHtml : fixtureHtml);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const fixtureUrl = `http://127.0.0.1:${port}/`;
  console.log(`[e2e] fixture server on ${fixtureUrl}`);

  const work = await context.newPage();
  await work.goto(fixtureUrl);

  // 7. Bring popup forward and click Record.
  await popup.bringToFront();
  await popup.locator("#rec").click();
  await expect(popup.locator("#stop")).toBeVisible({ timeout: 10_000 });
  console.log(`[e2e] recording started`);

  // 8. Drive a workflow on the work page. Use type() not fill() so real
  // keydown events are dispatched (fill() sets value directly, no keystrokes).
  await work.bringToFront();
  await work.waitForTimeout(400);
  await work.click("[data-testid=approve]");
  await work.waitForTimeout(300);
  await work.click("[data-testid=notes]");
  await work.locator("[data-testid=notes]").type("Refund approved per the no-questions policy under $200.");
  await work.waitForTimeout(300);
  await work.click("[data-testid=done]");
  // Let the page navigate (server serves /done) and the event flush.
  await work.waitForLoadState("load").catch(() => undefined);
  await work.waitForTimeout(1500);

  // 9. Bring popup forward and click Stop. With the v0.1.1 fixes the popup
  // transitions directly to the skill view of the just-stopped recording —
  // no library round-trip required.
  await popup.bringToFront();
  await popup.locator("#stop").click();
  await expect(popup.locator("#gen")).toBeVisible({ timeout: 15_000 });
  console.log(`[e2e] recording stopped, skill view open`);

  // 10. Click Generate Skill. Generate-skill doesn't require status='ready';
  // events are flushed before status is updated by stopRecording().
  await popup.locator("#gen").click();
  console.log(`[e2e] requesting skill generation`);

  // 11. Wait for the skill body to render. SKILL.md frontmatter starts with
  // "name:" — the marked() output renders the YAML as text in a <pre> or
  // similar. Easiest tell: a heading or the word "Steps".
  await expect(popup.getByText(/^## Steps/m).or(popup.getByText(/Steps/i))).toBeVisible({ timeout: 120_000 });

  // 12. Pull the rendered SKILL body. The popup renders body_md via marked()
  // into the #app subtree.
  const renderedText = await popup.locator("#app").innerText();
  console.log(`\n========== GENERATED SKILL (rendered) ==========\n${renderedText}\n========== END ==========\n`);

  // 13. Also fetch the raw row from the DB so we see the unedited SKILL.md.
  const { data: skills } = await admin
    .from("skills")
    .select("title, version, body_md, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (skills?.[0]) {
    console.log(`\n========== RAW SKILL.md ==========\n${skills[0].body_md}\n========== END ==========\n`);
  }

  // 14. Inspect what was actually captured.
  const { data: recRow } = await admin
    .from("recordings")
    .select("id,title,status,duration_ms,audio_path,transcript")
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
  console.log(`\n[e2e] capture summary:`);
  console.log(`  title:          ${recRow!.title ?? "(unset)"}`);
  console.log(`  status:         ${recRow!.status}`);
  console.log(`  duration:       ${recRow!.duration_ms}ms`);
  console.log(`  audio_path:     ${recRow!.audio_path ?? "(none)"}`);
  console.log(`  transcript:     ${JSON.stringify(recRow!.transcript)}`);
  console.log(`  events total:   ${events?.length ?? 0}`);
  console.log(`  events by kind: ${JSON.stringify(eventsByKind)}`);
  console.log(`  events w/ shot: ${withShot}`);

  expect(recRow!.title).toBeTruthy();
  expect(recRow!.status).toBe("ready");
  expect(eventsByKind.click).toBeGreaterThan(0);
  expect(eventsByKind.keydown).toBeGreaterThan(0);
  expect(eventsByKind.navigation).toBeGreaterThan(0);
  expect(withShot).toBeGreaterThan(0);
  expect(eventsByKind.screenshot_failed ?? 0).toBeLessThanOrEqual(1);

  // 15. Cleanup: delete the test user (cascades to recordings/events/skills via FK).
  await admin.auth.admin.deleteUser(userId);
  console.log(`[e2e] deleted test user`);

  await context.close();
  await new Promise<void>((r) => server.close(() => r()));
});

// NOTE: an end-to-end OTP-flow test would belong here, but Supabase enforces
// an email-send rate limit (default 3/hr/IP) that makes it flaky in CI. The
// popup -> verifyOtp path is verified manually in real Chrome. The error
// path is implicitly covered: when the rate limit triggers, the popup
// surfaces the message in #err, which is what we want.

test("pause/resume drops events while paused", async () => {
  test.setTimeout(120_000);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const email = `pause-${Date.now()}@scout-test.local`;
  const password = `Pass-${Date.now()}-Strong!`;
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (cErr) throw cErr;
  const userId = created.user!.id;

  const userSb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signed } = await userSb.auth.signInWithPassword({ email, password });
  const session = signed.session!;

  const profileDir = path.resolve(__dirname, ".chrome-profile-pause");
  if (fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, "--no-first-run", "--no-default-browser-check"],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);
  await popup.evaluate(async ({ projectRef, sess }) => {
    await chrome.storage.local.set({ [`sb-${projectRef}-auth-token`]: JSON.stringify(sess) });
  }, { projectRef: PROJECT_REF, sess: session });
  await popup.reload();
  await expect(popup.getByText(/Start Recording/i)).toBeVisible({ timeout: 15_000 });

  // Three buttons on a real http page so the content script injects.
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><body>
      <button data-testid="before">before</button>
      <button data-testid="during">during</button>
      <button data-testid="after">after</button>
    </body>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const work = await context.newPage();
  await work.goto(`http://127.0.0.1:${port}/`);

  await popup.bringToFront();
  await popup.locator("#rec").click();
  await expect(popup.locator("#stop")).toBeVisible({ timeout: 10_000 });

  // 1. Click 'before' — should be captured.
  await work.bringToFront();
  await work.click("[data-testid=before]");
  await work.waitForTimeout(300);

  // 2. Pause.
  await popup.bringToFront();
  await popup.locator("#pause").click();
  await expect(popup.getByRole("button", { name: /^resume$/i })).toBeVisible({ timeout: 5_000 });

  // 3. Click 'during' — should NOT be captured.
  await work.bringToFront();
  await work.click("[data-testid=during]");
  await work.waitForTimeout(500);

  // 4. Resume.
  await popup.bringToFront();
  await popup.locator("#pause").click(); // pause button reuses #pause id, label flips
  await expect(popup.getByRole("button", { name: /^pause$/i })).toBeVisible({ timeout: 5_000 });

  // 5. Click 'after' — should be captured.
  await work.bringToFront();
  await work.waitForTimeout(300);
  await work.click("[data-testid=after]");
  await work.waitForTimeout(500);

  // 6. Stop.
  await popup.bringToFront();
  await popup.locator("#stop").click();
  await expect(popup.locator("#gen")).toBeVisible({ timeout: 15_000 });

  // 7. Inspect events.
  const { data: rec } = await admin
    .from("recordings").select("id").eq("user_id", userId).single();
  const { data: events } = await admin
    .from("events").select("ts_ms,kind,data").eq("recording_id", rec!.id).order("ts_ms");

  const clickTargets = (events ?? [])
    .filter((e) => e.kind === "click")
    .map((e) => (e.data as { target?: { visibleText?: string } }).target?.visibleText ?? "");
  console.log(`[pause] click targets captured: ${JSON.stringify(clickTargets)}`);
  expect(clickTargets).toContain("before");
  expect(clickTargets).toContain("after");
  expect(clickTargets).not.toContain("during");

  await admin.auth.admin.deleteUser(userId);
  await context.close();
  await new Promise<void>((r) => server.close(() => r()));
});
