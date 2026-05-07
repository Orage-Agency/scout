// Iterate-tests — synthesize recordings of varying tasks and run /generate-skill
// on each, scoring the SKILL.md against quality criteria. Pure fetch — no
// supabase-js dependency so it runs from scout/ root directly.
//
// Run: node scripts/iterate-tests.mjs [start] [end]
//   default: start=0 end=15 (all)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "../.env");
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL = "admin@orage.agency";
const ADMIN_PASSWORD = "Orage-Admin-2026!";
const RUNTIME_URL = process.env.SCOUT_RUNTIME_URL ?? "http://localhost:3000";
const RUNTIME_KEY = process.env.SCOUT_RUNTIME_API_KEY;

function svc(path, init = {}) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function adminSignIn() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("signin failed: " + JSON.stringify(j));
  return { accessToken: j.access_token, userId: j.user.id };
}

const SCENARIOS = [
  // Each scenario: title, narration, events, optional inputs (used for dry-run).
  {
    title: "Approve refund under $200 in Zendesk",
    narration: [
      "I'm checking ticket twelve thousand three forty five for a refund request",
      "The amount is forty nine ninety nine, well under our two hundred dollar auto approve cap",
      "Customer says the product arrived damaged, we trust them on small refunds",
      "Clicking approve refund and adding the reason damaged on arrival",
      "Saving and moving on",
    ],
    events: [
      { kind: "navigate", data: { url: "https://orage.zendesk.com/agent/tickets/12345" } },
      { kind: "click", data: { selector: "button[data-test=refund]", text: "Refund" } },
      { kind: "input", data: { selector: "input[name=amount]", value: "49.99" } },
      { kind: "input", data: { selector: "textarea[name=reason]", value: "Damaged on arrival" } },
      { kind: "click", data: { selector: "button[type=submit]", text: "Approve refund" } },
    ],
  },
  {
    title: "Tag a Salesforce lead as Qualified",
    narration: [
      "Opening the lead for Acme Corp in Salesforce",
      "They had a great discovery call last week",
      "Updating the status to Qualified and adding a follow up task for next Tuesday",
    ],
    events: [
      { kind: "navigate", data: { url: "https://orage.lightning.force.com/lightning/r/Lead/00Q5g000001abcd/view" } },
      { kind: "click", data: { selector: "button[title='Edit Lead Status']" } },
      { kind: "click", data: { selector: "lightning-base-combobox-item[data-value=Qualified]" } },
      { kind: "click", data: { selector: "button[name=SaveEdit]", text: "Save" } },
    ],
  },
  {
    title: "Triage Gmail inbox — archive promotions",
    narration: [
      "Going through promotions tab in Gmail",
      "These are all marketing emails I don't need",
      "Selecting all and archiving",
    ],
    events: [
      { kind: "navigate", data: { url: "https://mail.google.com/mail/u/0/#category/promos" } },
      { kind: "click", data: { selector: "[aria-label='Select']" } },
      { kind: "click", data: { selector: "[aria-label='Archive']" } },
    ],
  },
  {
    title: "Create Linear issue from Slack thread",
    narration: [
      "There's a bug report in the customer support Slack channel",
      "Creating a Linear issue in the engineering project, priority high",
      "Title is checkout button frozen on safari, copying the message body as description",
    ],
    events: [
      { kind: "navigate", data: { url: "https://linear.app/orage/team/ENG/new" } },
      { kind: "input", data: { selector: "input[placeholder='Issue title']", value: "Checkout button frozen on Safari" } },
      { kind: "click", data: { selector: "button[aria-label='Set priority']" } },
      { kind: "click", data: { selector: "[data-priority=2]", text: "High" } },
      { kind: "click", data: { selector: "button[type=submit]", text: "Create" } },
    ],
  },
  {
    title: "Schedule 30 min meeting from email request",
    narration: [
      "John from Acme wants a thirty minute intro call this Thursday or Friday",
      "Checking my Google Calendar, Thursday 2pm is open",
      "Creating event titled Acme intro call, inviting john at acme dot com, sending invite",
    ],
    events: [
      { kind: "navigate", data: { url: "https://calendar.google.com/calendar/u/0/r/eventedit" } },
      { kind: "input", data: { selector: "input[aria-label='Add title']", value: "Acme intro call" } },
      { kind: "input", data: { selector: "input[aria-label='Add guests']", value: "john@acme.com" } },
      { kind: "click", data: { selector: "button[aria-label='Save']" } },
    ],
  },
  {
    title: "Create Notion page summarizing meeting notes",
    narration: [
      "Going to our team Notion workspace, meeting notes database",
      "Creating a new page titled today's date plus team standup",
      "Pasting the action items from the doc into the page",
    ],
    events: [
      { kind: "navigate", data: { url: "https://www.notion.so/orage/Meeting-Notes-abc123" } },
      { kind: "click", data: { selector: "button[aria-label='New']" } },
      { kind: "input", data: { selector: "h1[contenteditable=true]", value: "2026-05-07 — Team standup" } },
    ],
  },
  {
    title: "Open GitHub PR and request reviewers",
    narration: [
      "Pushing the feature branch and opening a PR against main",
      "Title is feat colon adds admin guest split",
      "Requesting review from Sarah and Mike, adding the backend label",
    ],
    events: [
      { kind: "navigate", data: { url: "https://github.com/orage-agency/scout/compare/main...feat/admin-guest" } },
      { kind: "click", data: { selector: "a[href*=compare]", text: "Create pull request" } },
      { kind: "input", data: { selector: "input#pull_request_title", value: "feat: adds admin guest split" } },
      { kind: "click", data: { selector: "button[type=submit]", text: "Create pull request" } },
    ],
  },
  {
    title: "Pull last week SaaS dashboard to CSV",
    narration: [
      "Going to the analytics tab in our admin dashboard",
      "Filtering to the last seven days",
      "Clicking export as CSV and saving to downloads",
    ],
    events: [
      { kind: "navigate", data: { url: "https://app.orage.agency/admin/analytics" } },
      { kind: "click", data: { selector: "button[data-test=date-range]" } },
      { kind: "click", data: { selector: "[data-value='last-7']" } },
      { kind: "click", data: { selector: "button[data-test=export-csv]" } },
    ],
  },
  {
    title: "Onboard new hire — create accounts in 3 SaaS tools",
    narration: [
      "New hire Sarah Chen joining engineering Monday",
      "Creating her Slack account at sarah at orage dot agency",
      "Then Linear with member role on engineering team",
      "Then GitHub adding her to the orage agency org",
    ],
    events: [
      { kind: "navigate", data: { url: "https://orage.slack.com/admin/invites" } },
      { kind: "input", data: { selector: "input[name=email]", value: "sarah@orage.agency" } },
      { kind: "click", data: { selector: "button[type=submit]" } },
      { kind: "navigate", data: { url: "https://linear.app/orage/settings/members" } },
      { kind: "navigate", data: { url: "https://github.com/orgs/orage-agency/people" } },
    ],
  },
  {
    title: "Issue Stripe refund for charge",
    narration: [
      "Customer paid twice by mistake, refunding the second charge",
      "Going to Stripe dashboard, finding charge ch underscore three KYZ",
      "Clicking refund, full amount, reason duplicate",
    ],
    events: [
      { kind: "navigate", data: { url: "https://dashboard.stripe.com/payments/ch_3KYZ123" } },
      { kind: "click", data: { selector: "button[data-test=refund-payment]" } },
      { kind: "click", data: { selector: "input[value=duplicate]" } },
      { kind: "click", data: { selector: "button[type=submit]", text: "Refund" } },
    ],
  },
  {
    title: "Schedule a tweet via Hypefury",
    narration: [
      "Drafting a tweet about the new release",
      "Scheduling for tomorrow at nine am",
      "Hypefury saves it to the queue",
    ],
    events: [
      { kind: "navigate", data: { url: "https://app.hypefury.com/queue" } },
      { kind: "click", data: { selector: "button[data-test=new-post]" } },
      { kind: "input", data: { selector: "textarea[placeholder='What is happening?']", value: "Scout v0.1.5 is live — record once, run anywhere." } },
    ],
  },
  {
    title: "Move Greenhouse candidate to next stage",
    narration: [
      "Just finished phone screen with Maria Lopez for senior eng role",
      "Moving her from phone screen to onsite stage",
      "Adding scorecard with strong yes",
    ],
    events: [
      { kind: "navigate", data: { url: "https://orage.greenhouse.io/people/12345" } },
      { kind: "click", data: { selector: "button[data-test=move-stage]" } },
      { kind: "click", data: { selector: "[data-stage=onsite]", text: "Onsite" } },
    ],
  },
  {
    title: "Escalate Linear ticket to engineering",
    narration: [
      "Customer issue is actually a bug not a config problem",
      "Moving the Linear ticket from support team to engineering team, priority high",
    ],
    events: [
      { kind: "navigate", data: { url: "https://linear.app/orage/issue/SUP-234" } },
      { kind: "click", data: { selector: "button[data-test=team-picker]" } },
      { kind: "click", data: { selector: "[data-team=engineering]" } },
    ],
  },
  {
    title: "Send marketing campaign via Resend",
    narration: [
      "Sending the May newsletter to our subscribers list",
      "Subject line is Scout learns to run skills",
      "Audience is the all subscribers list, sending now",
    ],
    events: [
      { kind: "navigate", data: { url: "https://resend.com/broadcasts/new" } },
      { kind: "input", data: { selector: "input[name=subject]", value: "Scout learns to run skills" } },
      { kind: "input", data: { selector: "input[name=audience]", value: "all-subscribers" } },
      { kind: "click", data: { selector: "button[data-test=send-now]" } },
    ],
  },
  {
    title: "Configure router QoS — UI-only embedded device",
    narration: [
      "Logging into the office router admin panel at one nine two dot one six eight dot one dot one",
      "QoS settings are in the advanced tab",
      "Setting Zoom traffic to high priority and saving",
    ],
    events: [
      { kind: "navigate", data: { url: "http://192.168.1.1/admin" } },
      { kind: "click", data: { selector: "a[href='#qos']", text: "QoS" } },
      { kind: "click", data: { selector: "input[name=zoom_priority]", value: "high" } },
      { kind: "click", data: { selector: "button#save", text: "Save" } },
    ],
  },
];

function scoreSkill(body_md) {
  const md = body_md ?? "";
  const hasFrontmatter = /^---\n[\s\S]*?\n---/.test(md);
  const hasVariables = /^## Variables\b/m.test(md);
  const hasFasterPath = /^## Faster path\b/m.test(md);
  const variablesSection = md.match(/## Variables\n([\s\S]*?)(?=\n## )/)?.[1] ?? "";
  const fasterPathSection = md.match(/## Faster path\n([\s\S]*?)(?=\n## )/)?.[1] ?? "";
  const stepsSection = md.match(/## Steps\n([\s\S]*?)(?=\n## )/)?.[1] ?? "";
  const isExplicitNone = /\(none[^)]*\)/i.test(variablesSection);
  const variablesListed = (variablesSection.match(/\{(\w+)\}/g) ?? []).map((s) => s.slice(1, -1));
  const placeholdersUsedInSteps = (stepsSection.match(/\{(\w+)\}/g) ?? []).map((s) => s.slice(1, -1));
  const placeholdersUsedInFaster = (fasterPathSection.match(/\{(\w+)\}/g) ?? []).map((s) => s.slice(1, -1));
  const allUsed = [...new Set([...placeholdersUsedInSteps, ...placeholdersUsedInFaster])];
  const declaredAlsoUsed = variablesListed.filter((v) => allUsed.includes(v));
  const fasterHasUrl = /https?:\/\//.test(fasterPathSection);
  const fasterHasCommand = /`[a-z][\w-]+/.test(fasterPathSection);
  const fasterIsUiOnly = /no faster automated path/i.test(fasterPathSection);

  const issues = [];
  if (!hasFrontmatter) issues.push("missing frontmatter");
  if (!hasVariables) issues.push("missing ## Variables section");
  if (!hasFasterPath) issues.push("missing ## Faster path section");
  if (variablesListed.length === 0 && hasVariables && !isExplicitNone) issues.push("Variables section is empty (and not explicit 'none')");
  if (variablesListed.length > 0 && declaredAlsoUsed.length < variablesListed.length)
    issues.push(`unused variables in body: ${variablesListed.filter((v) => !allUsed.includes(v)).join(", ")}`);
  if (hasFasterPath && !fasterIsUiOnly && !fasterHasUrl && !fasterHasCommand)
    issues.push("Faster path is hand-wavy (no URLs or commands)");

  const score = (hasFrontmatter ? 1 : 0)
    + (hasVariables ? 1 : 0)
    + (hasFasterPath ? 1 : 0)
    + (variablesListed.length > 0 || isExplicitNone ? 1 : 0)
    + ((declaredAlsoUsed.length === variablesListed.length && variablesListed.length > 0) || isExplicitNone ? 1 : 0)
    + (fasterIsUiOnly || fasterHasUrl || fasterHasCommand ? 1 : 0);

  return { score, variablesListed, fasterIsUiOnly, fasterHasUrl, fasterHasCommand, issues };
}

async function synthRecording(scenario, userId) {
  const recId = crypto.randomUUID();
  const segments = scenario.narration.map((text, i) => ({
    start_ms: i * 5000,
    end_ms: i * 5000 + 4500,
    text,
  }));
  const recRes = await svc("/rest/v1/recordings", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      id: recId,
      user_id: userId,
      title: scenario.title,
      status: "ready",
      started_at: new Date(Date.now() - 60_000).toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: 60_000,
      transcript: { segments },
      meta: { synth: true },
    }),
  });
  if (!recRes.ok) throw new Error(`insert recording: ${recRes.status} ${await recRes.text()}`);
  // Map simplified scenario events to production shapes. The summarizer in
  // generate-skill expects:
  //   click       → { target: { strategy, selector, visibleText }, tab_url }
  //   navigation  → { to_url }
  //   keydown     → { key, target }
  // Synthesized "navigate" / "input" need to be normalized.
  const eventRows = scenario.events.map((e, i) => {
    let kind = e.kind;
    let data = e.data;
    if (e.kind === "navigate") {
      kind = "navigation";
      data = { to_url: e.data.url };
    } else if (e.kind === "click") {
      data = {
        target: {
          strategy: "css",
          selector: e.data.selector,
          visibleText: e.data.text,
        },
        tab_url: scenario.events.slice(0, i).reverse().find((p) => p.kind === "navigate")?.data?.url ?? null,
      };
    } else if (e.kind === "input") {
      kind = "paste";
      data = { content_snippet: e.data.value, target: { strategy: "css", selector: e.data.selector } };
    }
    return {
      recording_id: recId,
      user_id: userId,
      ts_ms: i * 6000,
      kind,
      data,
      screenshot_path: null,
    };
  });
  if (eventRows.length) {
    const evRes = await svc("/rest/v1/events", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(eventRows),
    });
    if (!evRes.ok) throw new Error(`insert events: ${evRes.status} ${await evRes.text()}`);
  }
  return recId;
}

async function dryRunPlan(skillId, inputs) {
  const r = await fetch(`${RUNTIME_URL}/api/run`, {
    method: "POST",
    headers: { "x-runtime-key": RUNTIME_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ skill_id: skillId, inputs, dry_run: true }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`runtime ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function scorePlan(plan) {
  const issues = [];
  if (!plan) issues.push("no plan returned");
  if (plan?.error) issues.push(`runtime error: ${plan.error}`);
  if (plan?.ui_only) {
    return { score: 6, ui_only: true, actions: 0, vault_refs: 0, issues: [] };
  }
  if (!plan?.dry_run) issues.push("not flagged dry_run");
  const actions = plan?.plan?.actions ?? [];
  const hasActions = actions.length > 0;
  if (!hasActions) issues.push("no actions in plan");
  // Validate action shapes.
  let httpOk = 0;
  let httpBad = 0;
  let vaultRefs = 0;
  for (const a of actions) {
    if (a?.kind !== "http") { httpBad++; continue; }
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(a.method)) { httpBad++; continue; }
    if (!/^https?:\/\//.test(a.url)) { httpBad++; continue; }
    httpOk++;
    for (const v of Object.values(a.headers ?? {})) {
      if (typeof v === "string" && v.includes("$VAULT:")) vaultRefs++;
    }
  }
  if (httpBad > 0) issues.push(`${httpBad} malformed actions`);
  // Heuristic: if Faster path needed creds, the planner should have used $VAULT refs.
  // We don't have the body_md here easily; just count refs.
  const score = (hasActions ? 2 : 0)
    + (httpOk > 0 ? 2 : 0)
    + (httpBad === 0 ? 1 : 0)
    + ((plan?.summary ?? plan?.plan?.summary)?.length > 5 ? 1 : 0);
  return { score, actions: actions.length, http_ok: httpOk, http_bad: httpBad, vault_refs: vaultRefs, issues };
}

async function generateSkill(recordingId, accessToken) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/generate-skill`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: ANON,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recording_id: recordingId }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`generate-skill ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function cleanup(recordingIds) {
  if (!recordingIds.length) return;
  const ids = recordingIds.map((id) => `"${id}"`).join(",");
  await svc(`/rest/v1/recordings?id=in.(${ids})`, { method: "DELETE" });
}

async function main() {
  const start = Number(process.argv[2] ?? 0);
  const end = Number(process.argv[3] ?? SCENARIOS.length);
  console.log(`Running scenarios ${start}..${end - 1}`);

  const { accessToken, userId } = await adminSignIn();
  console.log(`Signed in as admin (${userId})`);

  const results = [];
  const cleanupIds = [];
  for (let i = start; i < end && i < SCENARIOS.length; i++) {
    const sc = SCENARIOS[i];
    console.log(`\n[${i}] ${sc.title}`);
    try {
      const recId = await synthRecording(sc, userId);
      cleanupIds.push(recId);
      const skill = await generateSkill(recId, accessToken);
      const score = scoreSkill(skill.body_md);
      console.log(`    skill: ${score.score}/6 — issues: ${score.issues.join("; ") || "none"}`);
      console.log(`    variables: [${score.variablesListed.join(", ")}]`);
      console.log(`    faster: ${score.fasterIsUiOnly ? "ui-only" : score.fasterHasUrl ? "has-url" : score.fasterHasCommand ? "has-command" : "vague"}`);
      // Dry-run via scout-runtime.
      let plan = null, planScore = null;
      try {
        plan = await dryRunPlan(skill.id, sc.inputs ?? {});
        planScore = scorePlan(plan);
        console.log(`    plan : ${planScore.score}/6 — actions: ${planScore.actions} (ok ${planScore.http_ok}, bad ${planScore.http_bad}) — vault_refs: ${planScore.vault_refs}`);
        if (planScore.issues.length) console.log(`           issues: ${planScore.issues.join("; ")}`);
      } catch (e) {
        console.log(`    plan : ERROR ${e.message}`);
        planScore = { score: 0, error: e.message };
      }
      results.push({ idx: i, title: sc.title, score, body_md: skill.body_md ?? "", plan, planScore });
    } catch (e) {
      console.log(`    ERROR: ${e.message}`);
      results.push({ idx: i, title: sc.title, error: e.message });
    }
  }

  const out = path.resolve(__dirname, `../tests/iteration-results-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${out}`);
  await cleanup(cleanupIds);
}

main().catch((e) => { console.error(e); process.exit(1); });
