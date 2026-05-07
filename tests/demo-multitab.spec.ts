// Realistic multi-tab demo. Two local fixtures simulate a small agency stack:
//   - http://orage-crm.local  : the agency's customer triage queue
//   - http://orage-kb.local   : the internal knowledge base
// (Both served from a single 127.0.0.1:port server with path-based routing.)
//
// The recording crosses tabs, navigates within tabs, types, and runs long
// enough (>60s) for the coach loop to fire at least once. After the run we
// dump the database state so we can prove every piece worked.
//
// Run: pnpm exec playwright test tests/demo-multitab.spec.ts --headed --reporter=list

import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

const EXT_DIR = path.resolve(__dirname, "../apps/extension/dist");
const USER_DATA_DIR = path.resolve(__dirname, ".chrome-profile-multitab");
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

const TEST_EMAIL = `multitab-${Date.now()}@scout-test.local`;
const TEST_PASSWORD = `Pass-${Date.now()}-Strong!`;

const STEP_PAUSE = 1000;

async function step(label: string, ms = STEP_PAUSE): Promise<void> {
  console.log(`\n>>> ${label}`);
  await new Promise((r) => setTimeout(r, ms));
}

const COMMON_STYLE = `body{font:14px/1.4 system-ui,sans-serif;margin:0;background:#f9fafb;color:#0f172a;}
.bar{background:#0f172a;color:#f1f5f9;padding:10px 24px;display:flex;gap:24px;align-items:center;}
.bar a{color:#94a3b8;text-decoration:none;}
.bar a.active{color:#f1f5f9;font-weight:600;}
main{padding:32px;max-width:720px;}
h1{margin:0 0 16px;}
.card{background:#fff;border:1px solid #e5e7eb;padding:16px 20px;margin:0 0 12px;border-radius:6px;}
button{padding:8px 14px;border:1px solid #cbd5e1;background:#fff;border-radius:4px;cursor:pointer;font:inherit;}
button.primary{background:#0f172a;color:#fff;border-color:#0f172a;}
input,textarea{font:inherit;padding:6px 10px;border:1px solid #cbd5e1;border-radius:4px;width:100%;box-sizing:border-box;}
.muted{color:#64748b;font-size:12px;}`;

function crmHome(): string {
  return `<!doctype html><html><head><title>Orage CRM — Triage queue</title><style>${COMMON_STYLE}</style></head>
<body>
  <div class="bar"><b>Orage CRM</b><a href="/crm/" class="active">Queue</a><a href="/crm/reports">Reports</a></div>
  <main>
    <h1>Customer triage queue</h1>
    <p class="muted">3 pending</p>
    <div class="card">
      <div><b>Alex Rivera</b> — Order #4421 — <b>$128.00</b></div>
      <div class="muted">Refund requested · 2026-05-04</div>
      <a href="/crm/ticket/4421"><button data-testid="open-4421" style="margin-top:10px">Open ticket</button></a>
    </div>
    <div class="card">
      <div><b>Pat Fernandez</b> — Order #4435 — <b>$612.50</b></div>
      <div class="muted">Refund requested · 2026-05-04</div>
      <a href="/crm/ticket/4435"><button data-testid="open-4435" style="margin-top:10px">Open ticket</button></a>
    </div>
    <div class="card">
      <div><b>Sam Chen</b> — Order #4444 — <b>$89.00</b></div>
      <div class="muted">Refund requested · 2026-05-04</div>
      <a href="/crm/ticket/4444"><button data-testid="open-4444" style="margin-top:10px">Open ticket</button></a>
    </div>
  </main>
</body></html>`;
}

function crmTicket(id: string, name: string, amount: string): string {
  return `<!doctype html><html><head><title>Orage CRM — Ticket #${id}</title><style>${COMMON_STYLE}</style></head>
<body>
  <div class="bar"><b>Orage CRM</b><a href="/crm/" class="active">Queue</a><a href="/crm/reports">Reports</a></div>
  <main>
    <a href="/crm/" class="muted">← Back to queue</a>
    <h1>Ticket #${id}</h1>
    <div class="card">
      <div><b>Customer:</b> ${name}</div>
      <div><b>Order:</b> #${id} · <b>${amount}</b></div>
      <div><b>Reason:</b> "It didn't fit, I want a refund."</div>
    </div>
    <div class="card">
      <label><b>Internal notes</b></label>
      <textarea data-testid="notes" rows="3"></textarea>
    </div>
    <div style="margin-top:16px;display:flex;gap:8px;">
      <button data-testid="approve" class="primary">Approve refund</button>
      <button data-testid="escalate">Escalate to supervisor</button>
      <a href="/crm/done"><button data-testid="done">Mark done</button></a>
    </div>
  </main>
</body></html>`;
}

function crmDone(): string {
  return `<!doctype html><html><head><title>Orage CRM — Done</title><style>${COMMON_STYLE}</style></head>
<body><div class="bar"><b>Orage CRM</b></div><main><h1>Done</h1><p>Refund processed and customer notified.</p></main></body></html>`;
}

function kbHome(): string {
  return `<!doctype html><html><head><title>Orage KB — Search</title><style>${COMMON_STYLE}</style></head>
<body>
  <div class="bar"><b>Orage Knowledge Base</b></div>
  <main>
    <h1>Search the policy library</h1>
    <input data-testid="kb-search" placeholder="Try: refund policy" />
    <ul style="margin-top:24px;padding:0;list-style:none;">
      <li class="card"><a href="/kb/refunds-under-200" data-testid="kb-refunds">Refunds under $200 — no-questions policy</a></li>
      <li class="card"><a href="/kb/refunds-large" data-testid="kb-refunds-large">Refunds at or above $500 — supervisor approval required</a></li>
      <li class="card"><a href="/kb/escalation" data-testid="kb-escalation">Escalation paths and SLA</a></li>
    </ul>
  </main>
</body></html>`;
}

function kbArticle(): string {
  return `<!doctype html><html><head><title>Orage KB — Refunds under $200</title><style>${COMMON_STYLE}</style></head>
<body>
  <div class="bar"><b>Orage Knowledge Base</b></div>
  <main>
    <a href="/kb/" class="muted">← Back to search</a>
    <h1>Refunds under $200</h1>
    <div class="card">
      <p><b>Policy:</b> any refund request under $200 is automatically approved under the no-questions policy.</p>
      <ul>
        <li>Document the rationale in the ticket's Internal notes.</li>
        <li>Click <b>Approve refund</b>, then <b>Mark done</b>.</li>
        <li>The customer is notified automatically.</li>
      </ul>
    </div>
    <div class="card">
      <p><b>Exceptions:</b> if the customer has 3+ prior refunds in 12 months, flag the account but still process.</p>
    </div>
  </main>
</body></html>`;
}

test("multi-tab: triage CRM + look up KB policy + approve", async () => {
  test.setTimeout(420_000);

  const admin = adminAuthClient();

  await step("creating test user");
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (cErr) throw cErr;
  const userId = created.user!.id;
  console.log(`    user ${TEST_EMAIL}`);

  const userSb = userAuthClient();
  const { data: signed } = await userSb.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  const session = signed!.session!;

  await step("starting local CRM + KB server");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    const url = req.url ?? "/";
    if (url === "/crm/" || url === "/crm" || url === "/") return res.end(crmHome());
    if (url === "/crm/ticket/4421") return res.end(crmTicket("4421", "Alex Rivera", "$128.00"));
    if (url === "/crm/ticket/4435") return res.end(crmTicket("4435", "Pat Fernandez", "$612.50"));
    if (url === "/crm/ticket/4444") return res.end(crmTicket("4444", "Sam Chen", "$89.00"));
    if (url === "/crm/done") return res.end(crmDone());
    if (url === "/crm/reports") return res.end(`<!doctype html><body><h1>Reports</h1></body>`);
    if (url === "/kb/" || url === "/kb") return res.end(kbHome());
    if (url === "/kb/refunds-under-200") return res.end(kbArticle());
    if (url === "/kb/refunds-large") return res.end(`<!doctype html><body><h1>Refunds at or above $500</h1><p>Requires supervisor approval.</p></body>`);
    if (url === "/kb/escalation") return res.end(`<!doctype html><body><h1>Escalation paths</h1></body>`);
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const crmUrl = `http://127.0.0.1:${port}/crm/`;
  const kbUrl = `http://127.0.0.1:${port}/kb/`;
  console.log(`    CRM at ${crmUrl}`);
  console.log(`    KB  at ${kbUrl}`);

  await step("launching Chromium with the Scout extension");
  if (fs.existsSync(USER_DATA_DIR)) fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  const context: BrowserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    slowMo: 280,
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
  sw.on("console", (m) => console.log(`    [sw ${m.type()}] ${m.text()}`));

  await step("opening the popup and injecting a real session");
  const popup = await context.newPage();
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

  await step("opening the CRM in the work tab BEFORE recording (tests injectContentIntoOpenTabs)");
  const crm = await context.newPage();
  await crm.goto(crmUrl);
  await expect(crm.locator("h1")).toHaveText("Customer triage queue");

  await step("clicking Record (extension should now inject content into the already-open CRM tab)");
  await popup.bringToFront();
  await popup.locator("#rec").click();
  await expect(popup.locator("#stop")).toBeVisible({ timeout: 10_000 });

  await step("step 1: open ticket 4421 in the CRM");
  await crm.bringToFront();
  await crm.click("[data-testid=open-4421]");
  await crm.waitForLoadState("load");
  await crm.waitForTimeout(800);

  await step("step 2: open the KB in a new tab and search");
  const kb = await context.newPage();
  await kb.goto(kbUrl);
  await expect(kb.locator("h1")).toHaveText("Search the policy library");
  await kb.waitForTimeout(500);
  await kb.click("[data-testid=kb-search]");
  await kb.locator("[data-testid=kb-search]").type("refund policy", { delay: 50 });
  await kb.waitForTimeout(800);

  await step("step 3: open the policy article");
  await kb.click("[data-testid=kb-refunds]");
  await kb.waitForLoadState("load");
  await kb.waitForTimeout(1500);

  await step("step 4: switch back to the CRM ticket");
  await crm.bringToFront();
  await crm.waitForTimeout(700);

  await step("step 5: write internal notes citing the policy");
  await crm.click("[data-testid=notes]");
  await crm.locator("[data-testid=notes]").type(
    "Refund approved per the no-questions policy under $200. KB article: refunds-under-200.",
    { delay: 30 },
  );
  await crm.waitForTimeout(700);

  await step("step 6: approve the refund");
  await crm.click("[data-testid=approve]");
  await crm.waitForTimeout(700);

  await step("waiting ~30s for the coach loop to fire its first ask");
  // Coach fires every 30s; the first ask has no minimum gap. While we wait,
  // do a couple more meaningful actions so there's something to coach about.
  await kb.bringToFront();
  await kb.waitForTimeout(8_000);
  await crm.bringToFront();
  await crm.waitForTimeout(8_000);
  // Switch to KB once more — gives coach more context-shift signals.
  await kb.bringToFront();
  await kb.waitForTimeout(8_000);
  await crm.bringToFront();
  await crm.waitForTimeout(8_000);

  await step("step 7: mark done (this navigates to /crm/done)");
  await crm.click("[data-testid=done]");
  await crm.waitForLoadState("load");
  await crm.waitForTimeout(1500);

  await step("clicking Stop");
  await popup.bringToFront();
  await popup.locator("#stop").click();
  await expect(popup.locator("#gen")).toBeVisible({ timeout: 15_000 });

  await step("Generate Skill (Claude via OpenRouter, ~30-60s)");
  await popup.locator("#gen").click();
  await expect(
    popup.getByText(/^## Steps/m).or(popup.getByText(/Steps/i)),
  ).toBeVisible({ timeout: 180_000 });

  const renderedText = await popup.locator("#app").innerText();
  console.log(`\n========== GENERATED SKILL (rendered) ==========\n${renderedText}\n========== END ==========\n`);

  await step("inspecting database state");
  const { data: recRow } = await admin
    .from("recordings")
    .select("id,title,status,duration_ms,audio_path,transcript")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(1)
    .single();
  const { data: events } = await admin
    .from("events")
    .select("ts_ms,kind,data,screenshot_path")
    .eq("recording_id", recRow!.id)
    .order("ts_ms");
  const { data: coachLog } = await admin
    .from("coach_log")
    .select("asked_at_ms,ask_text")
    .eq("recording_id", recRow!.id)
    .order("asked_at_ms");

  const eventsByKind = (events ?? []).reduce<Record<string, number>>((acc, e) => {
    acc[e.kind] = (acc[e.kind] ?? 0) + 1; return acc;
  }, {});
  const withShot = (events ?? []).filter((e) => e.screenshot_path).length;
  const distinctUrls = new Set<string>();
  for (const e of events ?? []) {
    const url = (e.data as { to_url?: string; tab_url?: string; to_tab_url?: string })?.to_url
      || (e.data as { tab_url?: string }).tab_url
      || (e.data as { to_tab_url?: string }).to_tab_url;
    if (url) distinctUrls.add(new URL(url).pathname);
  }
  console.log(`\n[multitab] capture summary:`);
  console.log(`  title:           ${recRow!.title ?? "(unset)"}`);
  console.log(`  status:          ${recRow!.status}`);
  console.log(`  duration:        ${recRow!.duration_ms}ms`);
  console.log(`  events total:    ${events?.length ?? 0}`);
  console.log(`  events by kind:  ${JSON.stringify(eventsByKind)}`);
  console.log(`  events w/ shot:  ${withShot}`);
  console.log(`  distinct paths:  ${JSON.stringify(Array.from(distinctUrls))}`);
  console.log(`  coach asks:      ${coachLog?.length ?? 0}`);
  if (coachLog?.length) {
    for (const c of coachLog) {
      console.log(`    ${Math.round(c.asked_at_ms/1000)}s -> "${c.ask_text}"`);
    }
  }

  expect(recRow!.status).toBe("ready");
  expect(eventsByKind.click ?? 0).toBeGreaterThan(0);
  expect(eventsByKind.tab_switch ?? 0).toBeGreaterThan(0);
  expect(eventsByKind.navigation ?? 0).toBeGreaterThan(0);
  expect(distinctUrls.size).toBeGreaterThanOrEqual(3);
  expect(withShot).toBeGreaterThan(3);

  await step("leaving window open 20s so you can inspect", 20_000);

  await admin.auth.admin.deleteUser(userId);
  await context.close();
  await new Promise<void>((r) => server.close(() => r()));
});
