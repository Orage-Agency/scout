// Iterate-tests v2 — 10 new scenarios across different SaaS verticals,
// run after the senior-dev review. Reuses synthRecording / scoring from v1.

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

function svc(p, init = {}) {
  return fetch(`${SUPABASE_URL}${p}`, {
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
  {
    title: "HubSpot — log a deal note on an active deal",
    narration: [
      "Opening deal Acme Q3 expansion in HubSpot",
      "They confirmed two thousand seat upgrade on todays call",
      "Adding a note to the deal so the rest of the team can see",
    ],
    events: [
      { kind: "navigate", data: { url: "https://app.hubspot.com/contacts/12345/deal/9876543" } },
      { kind: "click", data: { selector: "button[data-test=add-note]", text: "Add note" } },
      { kind: "input", data: { selector: "div[contenteditable=true]", value: "Acme confirmed 2000 seat upgrade on today's call. Closing this week." } },
      { kind: "click", data: { selector: "button[data-test=save-note]", text: "Save note" } },
    ],
  },
  {
    title: "Asana — create a task and assign with due date",
    narration: [
      "Sarah needs to write the Q3 retro doc by Friday",
      "Going to the Engineering Asana project",
      "New task, title write Q3 retro doc, assign to Sarah, due Friday",
    ],
    events: [
      { kind: "navigate", data: { url: "https://app.asana.com/0/123456789/list" } },
      { kind: "click", data: { selector: "button[aria-label='Add task']" } },
      { kind: "input", data: { selector: "input[name=task-name]", value: "Write Q3 retro doc" } },
      { kind: "click", data: { selector: "button[data-test=assignee]" } },
      { kind: "click", data: { selector: "[data-user=sarah]", text: "Sarah Chen" } },
      { kind: "click", data: { selector: "button[data-test=due-date]" } },
    ],
  },
  {
    title: "Discord — post announcement via webhook to #general",
    narration: [
      "Posting the release notes for v1 dot 5 to the team Discord",
      "Going to the channel general and pasting in the announcement",
    ],
    events: [
      { kind: "navigate", data: { url: "https://discord.com/channels/9876543/12345678" } },
      { kind: "click", data: { selector: "div[role=textbox]" } },
      { kind: "input", data: { selector: "div[role=textbox]", value: "@everyone Scout v1.5 is live — admin/guest split, vault, runtime. Try it out." } },
      { kind: "click", data: { selector: "button[type=submit]" } },
    ],
  },
  {
    title: "Shopify — process a partial refund on an order",
    narration: [
      "Customer wants partial refund of nineteen ninety nine because they only got two of three items",
      "Going to Shopify admin, finding order one zero two three four",
      "Clicking refund, refund amount nineteen ninety nine, reason short ship",
    ],
    events: [
      { kind: "navigate", data: { url: "https://admin.shopify.com/store/orage-store/orders/10234" } },
      { kind: "click", data: { selector: "button[data-test=refund]", text: "Refund" } },
      { kind: "input", data: { selector: "input[name=amount]", value: "19.99" } },
      { kind: "input", data: { selector: "textarea[name=reason]", value: "short ship — 1 of 3 items missing" } },
      { kind: "click", data: { selector: "button[type=submit]", text: "Refund" } },
    ],
  },
  {
    title: "Mixpanel — query last 30 day signup funnel",
    narration: [
      "Pulling the signup funnel for the last thirty days",
      "Going to Mixpanel insights, opening the signup funnel report",
      "Date range last thirty days, breakdown by source",
    ],
    events: [
      { kind: "navigate", data: { url: "https://mixpanel.com/project/orage/view/signup-funnel" } },
      { kind: "click", data: { selector: "button[data-test=date-range]" } },
      { kind: "click", data: { selector: "[data-value=last_30_days]", text: "Last 30 days" } },
      { kind: "click", data: { selector: "button[data-test=breakdown]" } },
      { kind: "click", data: { selector: "[data-value=source]", text: "Source" } },
      { kind: "click", data: { selector: "button[data-test=run-query]", text: "Run" } },
    ],
  },
  {
    title: "Calendly — cancel and reschedule a meeting",
    narration: [
      "John needs to push the Tuesday call to Thursday same time",
      "Going to Calendly events, finding the Tuesday booking with John at acme dot com",
      "Cancel reason rescheduling, then sending him a new link for Thursday two pm",
    ],
    events: [
      { kind: "navigate", data: { url: "https://calendly.com/event_types/scheduled" } },
      { kind: "click", data: { selector: "[data-event-id=evt_abc123]" } },
      { kind: "click", data: { selector: "button[data-test=cancel]", text: "Cancel event" } },
      { kind: "input", data: { selector: "textarea[name=reason]", value: "Rescheduling to Thursday" } },
      { kind: "click", data: { selector: "button[type=submit]", text: "Cancel" } },
    ],
  },
  {
    title: "DocuSign — send envelope using a template",
    narration: [
      "Sending the standard NDA template to a new vendor",
      "Going to DocuSign templates, picking standard NDA",
      "Recipient is jane at vendor dot com, subject please sign our NDA",
    ],
    events: [
      { kind: "navigate", data: { url: "https://app.docusign.com/templates" } },
      { kind: "click", data: { selector: "[data-template-id=tpl_nda]", text: "Standard NDA" } },
      { kind: "click", data: { selector: "button[data-test=use-template]", text: "Use template" } },
      { kind: "input", data: { selector: "input[name=recipient-email]", value: "jane@vendor.com" } },
      { kind: "input", data: { selector: "input[name=recipient-name]", value: "Jane Smith" } },
      { kind: "input", data: { selector: "input[name=subject]", value: "Please sign our NDA" } },
      { kind: "click", data: { selector: "button[type=submit]", text: "Send" } },
    ],
  },
  {
    title: "PagerDuty — acknowledge and resolve an incident",
    narration: [
      "Got paged for high error rate on api dot orage dot agency",
      "It was a brief blip, already recovered",
      "Acknowledging in PagerDuty then marking resolved with note transient spike",
    ],
    events: [
      { kind: "navigate", data: { url: "https://orage.pagerduty.com/incidents/PXYZ123" } },
      { kind: "click", data: { selector: "button[data-test=acknowledge]", text: "Acknowledge" } },
      { kind: "click", data: { selector: "button[data-test=resolve]", text: "Resolve" } },
      { kind: "input", data: { selector: "textarea[name=resolution-note]", value: "Transient spike, auto-recovered. Investigating root cause." } },
      { kind: "click", data: { selector: "button[type=submit]", text: "Resolve" } },
    ],
  },
  {
    title: "Twilio — send SMS from console",
    narration: [
      "Sending a quick text to the on call engineer about the deploy window",
      "Going to Twilio messaging, send a message to plus one five five five one two three four five six seven",
      "Body deploy window starts in ten minutes, please clear your branch",
    ],
    events: [
      { kind: "navigate", data: { url: "https://console.twilio.com/us1/develop/sms/try-it-out/send" } },
      { kind: "input", data: { selector: "input[name=to]", value: "+15551234567" } },
      { kind: "input", data: { selector: "textarea[name=body]", value: "Deploy window starts in 10 minutes, please clear your branch." } },
      { kind: "click", data: { selector: "button[type=submit]", text: "Send" } },
    ],
  },
  {
    title: "Vercel — redeploy a project",
    narration: [
      "Re running the latest deploy because it failed on a flaky test",
      "Going to the Vercel project dashboard, deployments tab",
      "Hovering on the failed one, clicking redeploy without cache",
    ],
    events: [
      { kind: "navigate", data: { url: "https://vercel.com/orage-agency/orage-flow/deployments" } },
      { kind: "click", data: { selector: "[data-deployment=dpl_abc123] button[aria-label=Actions]" } },
      { kind: "click", data: { selector: "[data-test=redeploy]", text: "Redeploy" } },
      { kind: "click", data: { selector: "input[name=use_existing_build_cache]" } },
      { kind: "click", data: { selector: "button[type=submit]", text: "Redeploy" } },
    ],
  },
];

function scoreSkill(body_md) {
  const md = body_md ?? "";
  const hasFrontmatter = /^---\n[\s\S]*?\n---/.test(md);
  const hasVariables = /^## Variables\b/m.test(md);
  const hasFasterPath = /^## Faster path\b/m.test(md);
  const hasInputExamples = /^## Input examples\b/m.test(md);
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
  if (!hasInputExamples) issues.push("missing ## Input examples section");
  if (variablesListed.length === 0 && hasVariables && !isExplicitNone) issues.push("Variables section is empty");
  if (variablesListed.length > 0 && declaredAlsoUsed.length < variablesListed.length)
    issues.push(`unused variables in body: ${variablesListed.filter((v) => !allUsed.includes(v)).join(", ")}`);
  if (hasFasterPath && !fasterIsUiOnly && !fasterHasUrl && !fasterHasCommand)
    issues.push("Faster path is hand-wavy");

  // Score out of 7 now that Input examples is required.
  const score = (hasFrontmatter ? 1 : 0)
    + (hasVariables ? 1 : 0)
    + (hasFasterPath ? 1 : 0)
    + (hasInputExamples ? 1 : 0)
    + ((variablesListed.length > 0 || isExplicitNone) ? 1 : 0)
    + (((declaredAlsoUsed.length === variablesListed.length && variablesListed.length > 0) || isExplicitNone) ? 1 : 0)
    + ((fasterIsUiOnly || fasterHasUrl || fasterHasCommand) ? 1 : 0);

  return { score, max: 7, variablesListed, fasterIsUiOnly, fasterHasUrl, fasterHasCommand, hasInputExamples, issues };
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
  let httpOk = 0, httpBad = 0, vaultRefs = 0;
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
  const summary = plan?.summary ?? plan?.plan?.summary;
  const score = (hasActions ? 2 : 0)
    + (httpOk > 0 ? 2 : 0)
    + (httpBad === 0 ? 1 : 0)
    + ((summary?.length ?? 0) > 5 ? 1 : 0);
  return { score, actions: actions.length, http_ok: httpOk, http_bad: httpBad, vault_refs: vaultRefs, issues };
}

async function synthRecording(scenario, userId) {
  const recId = crypto.randomUUID();
  const segments = scenario.narration.map((text, i) => ({
    start_ms: i * 5000, end_ms: i * 5000 + 4500, text,
  }));
  const recRes = await svc("/rest/v1/recordings", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      id: recId, user_id: userId, title: scenario.title, status: "ready",
      started_at: new Date(Date.now() - 60_000).toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: 60_000, transcript: { segments },
      meta: { synth: true, batch: "v2" },
    }),
  });
  if (!recRes.ok) throw new Error(`insert recording: ${recRes.status} ${await recRes.text()}`);
  const eventRows = scenario.events.map((e, i) => {
    let kind = e.kind, data = e.data;
    if (e.kind === "navigate") {
      kind = "navigation"; data = { to_url: e.data.url };
    } else if (e.kind === "click") {
      data = {
        target: { strategy: "css", selector: e.data.selector, visibleText: e.data.text },
        tab_url: scenario.events.slice(0, i).reverse().find((p) => p.kind === "navigate")?.data?.url ?? null,
      };
    } else if (e.kind === "input") {
      kind = "paste";
      data = { content_snippet: e.data.value, target: { strategy: "css", selector: e.data.selector } };
    }
    return { recording_id: recId, user_id: userId, ts_ms: i * 6000, kind, data, screenshot_path: null };
  });
  if (eventRows.length) {
    const evRes = await svc("/rest/v1/events", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify(eventRows),
    });
    if (!evRes.ok) throw new Error(`insert events: ${evRes.status} ${await evRes.text()}`);
  }
  return recId;
}

async function generateSkill(recordingId, accessToken) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/generate-skill`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`, apikey: ANON, "Content-Type": "application/json",
    },
    body: JSON.stringify({ recording_id: recordingId }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`generate-skill ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
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

async function cleanup(recordingIds) {
  if (!recordingIds.length) return;
  const ids = recordingIds.map((id) => `"${id}"`).join(",");
  await svc(`/rest/v1/recordings?id=in.(${ids})`, { method: "DELETE" });
}

async function main() {
  console.log(`Running v2 batch — ${SCENARIOS.length} new scenarios`);
  const { accessToken, userId } = await adminSignIn();
  const results = [];
  const cleanupIds = [];
  for (let i = 0; i < SCENARIOS.length; i++) {
    const sc = SCENARIOS[i];
    console.log(`\n[${i}] ${sc.title}`);
    try {
      const recId = await synthRecording(sc, userId);
      cleanupIds.push(recId);
      const skill = await generateSkill(recId, accessToken);
      const sScore = scoreSkill(skill.body_md);
      console.log(`    skill: ${sScore.score}/${sScore.max} — issues: ${sScore.issues.join("; ") || "none"}`);
      let plan = null, pScore = null;
      try {
        plan = await dryRunPlan(skill.id, sc.inputs ?? {});
        pScore = scorePlan(plan);
        console.log(`    plan : ${pScore.score}/6 — actions: ${pScore.actions} (ok ${pScore.http_ok}, bad ${pScore.http_bad}) — vault_refs: ${pScore.vault_refs}${pScore.issues.length ? " — issues: " + pScore.issues.join("; ") : ""}`);
      } catch (e) {
        console.log(`    plan : ERROR ${e.message}`);
        pScore = { score: 0, error: e.message };
      }
      results.push({ idx: i, title: sc.title, score: sScore, planScore: pScore, body_md: skill.body_md ?? "", plan });
    } catch (e) {
      console.log(`    ERROR: ${e.message}`);
      results.push({ idx: i, title: sc.title, error: e.message });
    }
  }
  const out = path.resolve(__dirname, `../tests/iteration-v2-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nResults: ${out}`);
  await cleanup(cleanupIds);
}

main().catch((e) => { console.error(e); process.exit(1); });
