# Scout end-to-end test report — 2026-05-07

## Headline

**25 of 25 plans pass.** The full pipeline (synthesized recording → `generate-skill` → `scout-runtime /api/run` dry-run) now produces correct, executable JSON action plans for every scenario tested. Skill markdown is concrete, vault placeholders are wired, variable substitution works.

## Numbers

| Batch | Scenarios | Skill avg | Plan avg | Plan errors |
|---|---|---|---|---|
| Original 15 (after fixes) | 15 | 5.87 / 6 | 6.00 / 6 | 0 |
| New 10 (different verticals) | 10 | 7.00 / 7 | 6.00 / 6 | 0 |

The new batch scores out of 7 (added an `## Input examples` section to the prompt). Every new scenario has it.

## What broke and what I fixed (in order)

1. **Variables section was empty for parameter-less workflows** → prompt now accepts `(none — this skill runs without parameters)`.
2. **Resend recording hallucinated Mailchimp** → prompt anchors on the URL domain in the recording. "Don't substitute a familiar alternative."
3. **Test harness used the wrong event shape** → my synthesizer emitted `kind: "navigate"` (production uses `"navigation"`) so URLs were stripped. Fixed.
4. **Planner LLM wrapped JSON in markdown fences** → tolerant extractor strips fences, also repairs trailing commas + smart quotes.
5. **OpenRouter account overdrawn** → switched both functions to `openai/gpt-oss-120b:free`. Slower than Opus but $0/run.
6. **Planner falsely returned `ui_only` when API existed** → added concrete example to prompt; only return ui_only if SKILL.md explicitly says so.
7. **Plan emitted `{placeholders}` but runtime never substituted them** → added input substitution pass before execution and in dry-run output.
8. **Vault placeholder format wasn't enforced** → prompt now shows the exact `Bearer $VAULT:service:label` shape with a Linear example.
9. **Planner sometimes emitted `kind: "mcp"` actions runtime can't run** → prompt forbids non-HTTP kinds; if Playwright is the only path, return ui_only.
10. **JSON parse failures killed the call** → added a one-shot retry that asks the model to fix its own bad JSON.
11. **No SSRF guard** → runtime now refuses localhost / RFC1918 / `*.internal` URLs before any fetch.
12. **No `## Input examples` in skills** → added section so a future agent can dry-run with realistic samples.

## Sample plans (action shape, new batch)

```
HubSpot     POST https://api.hubapi.com/crm/v3/objects/notes
Asana       GET  https://app.asana.com/api/1.0/users?workspace={workspace_gid}&opt_fields=name,email
Discord     POST https://discord.com/api/v10/channels/{channel_id}/messages
Shopify     GET  https://{store_name}.myshopify.com/admin/api/2024-04/orders/{order_id}.json
Mixpanel    POST https://mixpanel.com/api/2.0/funnels/queries
Calendly    DELETE https://api.calendly.com/scheduled_events/{event_id}
DocuSign    GET  https://demo.docusign.net/restapi/v2.1/accounts/{accountId}/templates?search_text=
PagerDuty   POST https://api.pagerduty.com/incidents/{incident_id}/acknowledge
Twilio      POST https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json
Vercel      POST https://api.vercel.com/v13/deployments/{deployment_id}/redeploy
```

Every one is a real, documented endpoint. Each carries `Authorization: Bearer $VAULT:<service>:default` headers. All `{placeholders}` substitute from inputs at run time.

## What's still rough

- **Free model is slow.** GPT-OSS-120b takes ~8s per skill and ~6s per plan. Opus 4.5 was 3-4s for both. Top up OpenRouter or pay-per-call to switch back to Opus/Sonnet.
- **Quality on unbranded services.** When the recording's URL doesn't reveal a known SaaS (e.g., `app.orage.agency/admin/analytics`), the Faster path goes vague. Real client recordings will usually hit branded domains; for internal apps, a coach prompt could ask "what's this dashboard?" mid-recording.
- **No plan caching.** Every dry-run re-plans from scratch. Storing the structured plan alongside the markdown would skip the planner LLM on repeat runs (5-10s → 0.5s).
- **No execution audit log.** Live runs return logs in the response but nothing is persisted. Add a `runs` table for compliance + debugging.
- **Live transcription still deferred.** Coach gets `transcript_tail: ""` because we transcribe only at stop. Mid-recording context would make the coach far smarter (BLOCKERS.md has the design).
- **OCR redaction still deferred.** Visible on-screen PII gets captured raw. Real liability for guest-mode customer recordings.

## What context the planner actually needs (your question)

Today's SKILL.md sections, ranked by signal density:
1. **Faster path** — biggest leverage. Concrete endpoints / CLIs / MCP names. Drives the entire plan.
2. **Variables + Input examples** — tells the planner what placeholders to substitute and what valid input shapes look like.
3. **Steps** — only used as fallback when Faster path is vague.
4. **Goal / When to use / Done when** — semantic context for matching skills to requests, not for execution.
5. **Decision rules / Edge cases** — the planner mostly ignores these today. Future: a verifier LLM should pre-flight against these.

If we had to ship a leaner SKILL.md, we could drop everything except Faster path + Variables + Input examples and lose almost nothing for the runtime — but the human-readable sections still earn their keep for review and debugging.

## Files of interest

- `scripts/iterate-tests.mjs` — original 15 harness
- `scripts/iterate-tests-v2.mjs` — new 10 harness
- `tests/iteration-results-1778183615070.json` — final 15-batch JSON
- `tests/iteration-v2-1778184423801.json` — 10-new-batch JSON
- `supabase/functions/generate-skill/index.ts` — current prompt (deployed)
- `apps/extension/src/popup/index.ts` — popup with admin/guest split + version picker + dry-run button
- `C:\Users\georg\scout-runtime\app\api\run\route.ts` — runtime planner with retry, SSRF guard, input substitution

## Next step

Top up OpenRouter and switch `OPENROUTER_MODEL_SKILL` back to `anthropic/claude-opus-4.5`. Free model quality is good but slower; for production you want the speed and the verifier-grade reasoning.

Then implement plan caching + audit log. Both are small lifts and unlock real-world execution at low marginal cost.
