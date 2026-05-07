# Scout skill-generation retro — 15 iterations, 2026-05-07

## Headline

15/15 scored 6/6 after two prompt fixes and one test-harness fix. Faster paths are concrete: real API endpoints, real CLI commands, real MCP tool names.

## Scenarios

| # | Workflow | Faster path identified |
|---|---|---|
| 0 | Approve refund in Zendesk | Zendesk Tickets API |
| 1 | Tag Salesforce lead Qualified | Salesforce REST API (sObjects) |
| 2 | Triage Gmail promos | Gmail API batchModify with pagination |
| 3 | Create Linear issue from Slack | Linear MCP + Linear GraphQL |
| 4 | Schedule Google Calendar meeting | Calendar API insert with sendUpdates |
| 5 | Create Notion page | Notion MCP + Notion REST |
| 6 | Open GitHub PR + reviewers | `gh pr create` one-liner |
| 7 | Pull dashboard CSV | Generic API placeholder (dashboard unbranded) |
| 8 | Onboard new hire (3 SaaS) | Slack SCIM + Linear + GitHub APIs |
| 9 | Issue Stripe refund | Stripe API + CLI + SDK |
| 10 | Schedule tweet via Hypefury | No public API → Playwright MCP fallback |
| 11 | Move Greenhouse candidate | Greenhouse Harvest API |
| 12 | Escalate Linear ticket | Linear MCP + GraphQL mutation |
| 13 | Send Resend campaign | Resend Broadcasts API (correct service) |
| 14 | Router QoS (UI-only) | Correctly admits no API; suggests Playwright MCP |

## What I corrected mid-run

**Fix 1 — empty Variables section (after batch 1).** Scenario #2 (Gmail triage) has no parameters; the model wrote an empty `## Variables` section that my scorer flagged as a failure. Tightened the prompt to require either a non-empty list or the literal string `(none — this skill runs without parameters)`. After: parameter-less workflows score cleanly.

**Fix 2 — service hallucination (after batch 3).** Scenario #13 (Resend) initially produced *Mailchimp* API calls because the model substituted a more-familiar alternative. Added an explicit anchor to the prompt: identify the service from the observed URL domain (resend.com → Resend), do NOT propose a substitute. After: Resend correctly routed.

**Fix 3 — test harness (not the prompt).** My synthesized events used `kind: "navigate"` while the production extension emits `kind: "navigation"` with a `data.target` object shape. The summarizer was filtering my fake events. Fixed the synth to use production shapes — this restored URL signal to the LLM.

## What's still rough

- **Scoring is structural, not executable.** I checked the SKILL.md for the right sections and concrete-looking endpoints; I did NOT actually call those endpoints to verify they work. A real Stripe call in dry-run mode (via scout-runtime) would catch any subtle wrongness.

- **Variable minimization is bumpy.** The first run of #4 declared 8 variables but used 5 — a "every concrete value is a variable" failure mode. Fix-1's prompt tightening solved this in re-run, but watch for regressions: when narration mentions both `contact_name` and `contact_email`, the model should pick one.

- **Generic services degrade gracefully but vaguely.** #7 (Pull dashboard to CSV) gave a generic API placeholder because the dashboard wasn't a known brand. Real recordings will usually have a brand domain in the URL — but if not, we get hand-wavy output. Could fix with a coach prompt that asks "what's this dashboard?" mid-recording.

- **The runtime planner hasn't been validated against these skills yet.** Skill-generation looks great; converting these SKILL.md files into actual /api/run plans is the next test. That requires standing up scout-runtime locally.

## What I'd test next

1. **End-to-end dry-run.** Pick three of these 15 (one easy: Stripe; one MCP: Linear; one UI-only: router) and run them through `scout-runtime /api/run` with `dry_run: true`. Verify the planner converts the SKILL.md into the right JSON action plan.

2. **Real execution against a sandbox.** Stripe has a test mode with throwaway accounts — wire up a test API key in the vault, run the Stripe refund skill end-to-end against test charges. This is the first real proof that Scout → runtime → external API works.

3. **Multi-step workflows.** All 15 here are linear. Test branching (e.g., "if amount > $500, also notify finance"). Decision rules section needs to translate into conditional plan actions.

4. **Variable substitution accuracy.** Run the same skill twice with different inputs, confirm the planner generates URLs/bodies with the right substitutions.

## Files

- Test runner: `scripts/iterate-tests.mjs`
- Last full pass: `tests/iteration-results-1778180457772.json` (15 SKILL.md bodies + scores)
- Two prompt revisions live in `supabase/functions/generate-skill/index.ts` (deployed)
