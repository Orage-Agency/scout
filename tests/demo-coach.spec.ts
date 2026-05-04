// Coach-firing test. Designed to provoke the coach into asking at least one
// question per brief §16.1.6.
//
// Why the previous tests stayed silent: the workflow was self-explaining
// (typed notes citing the policy, only one ticket, obvious "approve"). Coach
// defaulted to silence — correct behavior per §9.2.
//
// This test is the opposite. Three similar tickets are open. The user
// approves one, escalates one, and ignores one — without typing any
// rationale, without narration. That's the textbook "non-obvious decision
// without narrating why" trigger.

import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

const EXT_DIR = path.resolve(__dirname, "../apps/extension/dist");
const USER_DATA_DIR = path.resolve(__dirname, ".chrome-profile-coach");
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

const TEST_EMAIL = `coach-${Date.now()}@scout-test.local`;
const TEST_PASSWORD = `Pass-${Date.now()}-Strong!`;

async function step(label: string, ms = 1000): Promise<void> {
  console.log(`\n>>> ${label}`);
  await new Promise((r) => setTimeout(r, ms));
}

const STYLE = `body{font:14px/1.4 system-ui,sans-serif;margin:0;background:#f9fafb;color:#0f172a;}
.bar{background:#0f172a;color:#f1f5f9;padding:10px 24px;}
main{padding:32px;max-width:720px;}
h1{margin:0 0 16px;}
.card{background:#fff;border:1px solid #e5e7eb;padding:16px 20px;margin:0 0 12px;border-radius:6px;display:flex;gap:12px;align-items:center;}
.card .meta{flex:1;}
button{padding:6px 12px;border:1px solid #cbd5e1;background:#fff;border-radius:4px;cursor:pointer;font:inherit;}
button.primary{background:#16a34a;color:#fff;border-color:#16a34a;}
button.warn{background:#f59e0b;color:#fff;border-color:#f59e0b;}`;

function queueHtml(): string {
  return `<!doctype html><html><head><title>Triage Queue</title><style>${STYLE}</style></head>
<body><div class="bar"><b>Triage</b></div><main>
  <h1>Pending refunds</h1>
  <div class="card">
    <div class="meta"><b>#A101</b> · Maria Santos · $147.00 · "wrong size"</div>
    <button class="primary" data-testid="approve-A101">Approve</button>
    <button class="warn" data-testid="escalate-A101">Escalate</button>
    <button data-testid="defer-A101">Defer</button>
  </div>
  <div class="card">
    <div class="meta"><b>#A102</b> · David Kim · $158.00 · "wrong size"</div>
    <button class="primary" data-testid="approve-A102">Approve</button>
    <button class="warn" data-testid="escalate-A102">Escalate</button>
    <button data-testid="defer-A102">Defer</button>
  </div>
  <div class="card">
    <div class="meta"><b>#A103</b> · Emma Walsh · $152.00 · "wrong size"</div>
    <button class="primary" data-testid="approve-A103">Approve</button>
    <button class="warn" data-testid="escalate-A103">Escalate</button>
    <button data-testid="defer-A103">Defer</button>
  </div>
  <div class="card">
    <div class="meta"><b>#A104</b> · Noah Patel · $144.00 · "wrong size"</div>
    <button class="primary" data-testid="approve-A104">Approve</button>
    <button class="warn" data-testid="escalate-A104">Escalate</button>
    <button data-testid="defer-A104">Defer</button>
  </div>
</main></body></html>`;
}

test("coach fires on ambiguous workflow", async () => {
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

  const userSb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signed } = await userSb.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  const session = signed!.session!;

  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(queueHtml());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const fixtureUrl = `http://127.0.0.1:${port}/`;

  if (fs.existsSync(USER_DATA_DIR)) fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  const ctx: BrowserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
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
  await work.goto(fixtureUrl);

  await step("starting recording");
  await popup.bringToFront();
  await popup.locator("#rec").click();
  await expect(popup.locator("#stop")).toBeVisible({ timeout: 10_000 });

  // The actions below are deliberately ambiguous: similar tickets, similar
  // amounts, similar reasons. We approve some, escalate one, defer one —
  // without explaining why. No notes, no narration. Per §9.2 this is exactly
  // the "non-obvious decision the user didn't narrate" trigger.
  await step("approving #A101");
  await work.bringToFront();
  await work.click("[data-testid=approve-A101]");
  await work.waitForTimeout(2_000);

  await step("waiting (no narration, no notes — coach should notice)");
  await work.waitForTimeout(8_000);

  await step("escalating #A102 (similar amount, similar reason — why?)");
  await work.click("[data-testid=escalate-A102]");
  await work.waitForTimeout(3_000);

  await step("approving #A103");
  await work.click("[data-testid=approve-A103]");
  await work.waitForTimeout(3_000);

  // Wait through coach loop fire windows. Coach interval is 30s. Need the
  // recording to be at least ~32s in for the first cycle to have completed
  // its LLM call. Drop in a long pause so coach has plenty of "no narration"
  // signal too.
  await step("long silent pause (>20s — explicit coach trigger per §9.2)", 26_000);

  await step("deferring #A104 — yet another opaque decision");
  await work.click("[data-testid=defer-A104]");
  await work.waitForTimeout(3_000);

  await step("more silent waiting", 12_000);

  await step("clicking Stop");
  await popup.bringToFront();
  await popup.locator("#stop").click();
  await expect(popup.locator("#gen")).toBeVisible({ timeout: 15_000 });

  await step("inspecting coach_log");
  const { data: rec } = await admin
    .from("recordings")
    .select("id,duration_ms")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(1)
    .single();
  const { data: coachLog } = await admin
    .from("coach_log")
    .select("asked_at_ms,ask_text,reply_transcript")
    .eq("recording_id", rec!.id)
    .order("asked_at_ms");

  console.log(`\n[coach] recording duration: ${rec!.duration_ms}ms`);
  console.log(`[coach] coach asks logged:   ${coachLog?.length ?? 0}`);
  for (const c of coachLog ?? []) {
    console.log(`    ${Math.round(c.asked_at_ms / 1000)}s -> "${c.ask_text}"`);
  }

  expect(coachLog?.length ?? 0).toBeGreaterThanOrEqual(1);

  await step("leaving open 10s", 10_000);

  await admin.auth.admin.deleteUser(userId);
  await ctx.close();
  await new Promise<void>((r) => server.close(() => r()));
});
