---
name: orage-sales-presentation-rehearsal
version: 1
description: Run a full rehearsal of the Orage sales presentation app, navigating all 12 phases, revealing beats in sequence, capturing prospect answers, and advancing screens to complete a mock sales call.
---

# Orage Sales Presentation — Full Rehearsal Run

## Goal
Walk through the Orage sales presentation app in rehearsal mode for a named prospect, progressing through all 12 phases (Welcome & Frame → Commitment). The presenter reveals scripted beats one at a time, captures prospect answers into input fields, locks them in, and advances screens — ending with the "If We Close Today" bonus reveal.

## When to use
- A sales rep is rehearsing or running a live discovery call using the Orage presentation app.
- The session URL contains `?rehearsal=1` or is a live `/present/` session.
- The agent needs to simulate or automate a full run-through of the presentation for testing or demo purposes.
- A new prospect session needs to be exercised end-to-end to verify all phases render correctly.

## Inputs
- The presentation session URL (including prospect ID and rehearsal flag).
- Prospect name (used to verify the correct session is loaded).
- Answers to each discovery question that will be typed into the presentation fields.

## Input examples

```json
{
  "session_url": "https://v0-sales-presentation-app-orageagency.vercel.app/present/g57gfe04?rehearsal=1",
  "prospect_name": "George",
  "why_they_came": "hub spot go high level and I have several AI tools so I would be able to grow without sweat on every dollar",
  "business_description": "I own a marketing agency",
  "team_description": "I have a team of 10 people",
  "top_pain": "talent",
  "founder_weekly_hours": "40",
  "founder_hourly_rate": "500",
  "team_weekly_hours": "25",
  "team_hourly_rate": "25",
  "missed_revenue_per_month": "10000",
  "pain_duration": "1-2 years",
  "phase2_vision": "I would be able to grow without sweat on every dollar",
  "vision_timeline": "30_days",
  "highlighted_vectors": ["Admin Workflow Automation", "Inbound Funnel Acceleration"]
}
```

## Variables
- {session_url}: Full URL of the presentation session including prospect ID and rehearsal flag (example: `https://v0-sales-presentation-app-orageagency.vercel.app/present/g57gfe04?rehearsal=1`)
- {prospect_name}: First name of the prospect shown in the top-right corner (example: `George`)
- {why_they_came}: Prospect's answer to what brought them in (example: `hub spot go high level and I have several AI tools`)
- {business_description}: Prospect's description of their business (example: `I own a marketing agency`)
- {team_description}: Prospect's description of their team (example: `I have a team of 10 people`)
- {top_pain}: The primary pain point identified (example: `talent`)
- {founder_weekly_hours}: Hours per week the founder spends on the problem (example: `40`)
- {founder_hourly_rate}: Dollar value of one hour of the founder's time (example: `500`)
- {team_weekly_hours}: Hours per week the team spends on the problem (example: `25`)
- {team_hourly_rate}: Average hourly cost of a team member (example: `25`)
- {missed_revenue_per_month}: Estimated monthly revenue lost to the problem (example: `10000`)
- {highlighted_vectors}: Which attack vectors to highlight/select (example: `["Admin Workflow Automation", "Inbound Funnel Acceleration"]`)

## Steps

### Phase 1 — Welcome & Frame (Screen 1/12)

1. Navigate to {session_url}. Confirm the top-right corner shows "PROSPECT: {prospect_name}" and the right panel shows "PHASE 1 — WELCOME & FRAME".
2. In the right-side coach panel under BEATS, click the **REVEAL** button next to "Reveal greeting". The prospect view will animate the first element onto the screen.
3. Click **REVEAL** next to "Reveal mission statement". Deliver the scripted "Say This" lines aloud (or read them): set the call structure, explain the questions-then-dreams-then-plan format.
4. Click **REVEAL** next to "Reveal gold line + begin". Listen for pain language vs. curiosity language from the prospect.
5. Click **NEXT SCREEN →** at the bottom of the coach panel to advance to Screen 2.

### Phase 1 — What Brings You Here (Screen 2/12)

6. The panel now shows "PHASE 1 — WHAT BRINGS YOU HERE". Click **REVEAL** to show the question on the prospect's view.
7. Click **REVEAL** again to show the context line beneath the question.
8. Click **REVEAL** a third time to reveal the input field on the prospect's view.
9. The prospect's answer appears as a text area. Click into the textarea labeled with the "WHAT BRINGS YOU IN HERE TODAY?" prompt and type {why_they_came}.
10. If you need to correct the text, use Backspace to delete and retype. When satisfied, click **LOCK IN** to commit the answer. The field will show as locked on the prospect view.
11. If an interstitial overlay activates (e.g., "Let's begin", "Pause to breathe"), click the active interstitial button in the INTERSTITIALS panel to display it on the prospect screen, then click it again or click **EXIT** to dismiss it before continuing.
12. Click **NEXT SCREEN →** to advance to Screen 3.

### Phase 2 — The Landscape (Screen 3/12)

13. The panel shows "PHASE 2 — THE LANDSCAPE". Click **REVEAL** next to "Ask about the business" to show the "TELL ME ABOUT THE BUSINESS." prompt on the prospect view.
14. Type {business_description} into the business textarea. Click **LOCK IN**. The field locks and shows "BUSINESS LOCKED" on the prospect view.
15. Click **REVEAL** next to "Ask about the team" to reveal the "WHO'S ON YOUR TEAM?" question.
16. Type {team_description} into the team textarea. Click **LOCK IN**. The field locks and shows "TEAM LOCKED".
17. Click **REVEAL** next to "Ask about systems" to reveal the systems question.
18. Type the prospect's answer about their current systems into the systems textarea. Click **LOCK IN**.
19. Click **REVEAL** next to "The quiet question" to reveal the final landscape question.
20. Click **NEXT SCREEN →** to advance to Screen 4.

### Phase 3 — The Pain (Screen 4/12)

21. The panel shows "PHASE 3 — THE PAIN". The objective is to quantify every dimension of the pain so the math gut-punches the prospect.
22. Click **REVEAL** next to "Name the pain". A field appears for the top pain. The prospect's top pain ({top_pain}) should already be populated from context, or type it in. Click **LOCK IN** / **UNLOCK** as needed to confirm.
23. Click **REVEAL** next to "Founder's weekly hours". An input field labeled "HOW MANY HOURS A WEEK IS THIS TAKING FROM YOU PERSONALLY?" appears. Enter {founder_weekly_hours}.
24. Click **REVEAL** next to "Founder's hourly rate". An input field labeled "WHAT'S AN HOUR OF YOUR TIME WORTH?" appears. Enter {founder_hourly_rate}.
25. Click **REVEAL** next to "Team's weekly hours". An input field labeled "HOW MANY HOURS A WEEK IS YOUR TEAM SPENDING ON THIS?" appears. Enter {team_weekly_hours}.
26. Click **REVEAL** next to "Team's hourly rate". An input field labeled "WHAT'S AN AVERAGE HOUR OF YOUR TEAM'S TIME COST YOU?" appears. Enter {team_hourly_rate}.
27. Click **REVEAL** next to "Missed revenue per month". An input field labeled "HOW MUCH REVENUE DOES THIS PROBLEM COST IN A TYPICAL MONTH?" appears. Enter {missed_revenue_per_month}. Note: if the coach asks "Where does that number come from?", probe the prospect to confirm the figure is grounded in real missed deals, lost leads, or cancelled jobs — do not accept a vague estimate.
28. Click **REVEAL** next to "Duration selector". A duration picker appears. Select the appropriate duration (e.g., "1-2 years").
29. Click **REVEAL** next to "The big reveal". The calculated annual cost of the pain displays dramatically on the prospect view. Pause and let the number land — do not speak immediately.
30. Click **NEXT SCREEN →** to advance to Screen 5.

### Phase 4 — Live Diagnostic (Screen 5/12)

31. The panel shows "PHASE 4 — LIVE DIAGNOSTIC". The AI action button reads "RUN DIAGNOSTIC — DONE" (marked COMPLETE if the AI has already run). If not complete, click **RUN DIAGNOSTIC — DONE** to trigger the diagnostic scan.
32. The prospect view shows "ATTACK VECTORS" with four cards: 24/7 AI Phone Agent, Admin Workflow Automation, Inbound Funnel Acceleration, Daily Operational Pulse.
33. In the HIGHLIGHT VECTORS section of the coach panel, click the vectors most relevant to the prospect's pain to highlight them on the prospect view. Select the vectors from {highlighted_vectors}.
34. Click **LOCK SELECTION** to lock the highlighted vectors.
35. Click **NEXT SCREEN →** to advance to Screen 6.

### Phases 5–7 — Vision, Plan, Projections (Screens 6–8/12)

36. Continue through each screen by following the BEATS list in the coach panel: click each **REVEAL** button in order, deliver the scripted "Say This" lines, and fill in any input fields that appear (vision timeline, dream outcome, personal motivation).
37. On the "YOUR CUSTOM PLAN" screen (Phase 6, Screen 8/12), the AI generates a 90-day plan. Wait for the "GENERATE PLAN — DONE" button to show COMPLETE, then walk the prospect through the plan phases (Week 1-2: first win, Week 3-6: adoption, Week 7-10: bottlenecks, Week 11-12+: compounding).
38. Click **NEXT SCREEN →** after each screen.

### Phases 8–10 — Commitment, Bonuses, Close (Screens 9–12/12)

39. On the "IF WE CLOSE TODAY" screen (Phase 8, Screen 11/12), click **REVEAL** next to each bonus in sequence:
    - "Reveal Daily Data Pulse" ($1,200 value)
    - "Reveal Founder's Framework" ($2,000 value)
    - "Reveal AI First Impression" ($1,500 value)
    - "Reveal total value" — the screen shows TOTAL VALUE: $4,700
40. Let the screen speak. Do not narrate the total — silence is the close.
41. Listen for "That's a lot of value" as a buying signal. If heard, proceed directly to the commitment screen.
42. Click **NEXT SCREEN →** to advance to the final commitment screen (Screen 12/12).
43. On the commitment screen, capture the prospect's payment option choice and status. Click **LOCK IN** or the equivalent commit button.

### Interstitials (any screen)

44. At any point, if you need to display a hold/interstitial message on the prospect's screen (e.g., while you look something up or need a moment), expand the INTERSTITIALS panel and click the desired interstitial: "Welcome George", "So happy you're here", "Taking the world by storm", "Let's begin", or "Pause to breathe". The prospect view will show that message full-screen. Click the active interstitial again or click EXIT to return to the current slide.

## Faster path

The service is a custom Vercel-hosted app (`v0-sales-presentation-app-orageagency.vercel.app`). It has no documented public REST API or known MCP server.

**Playwright MCP** is the appropriate automation fallback for UI-driven steps:

```
// Navigate to session
playwright_navigate({ url: "{session_url}" })

// Click REVEAL buttons sequentially
playwright_click({ selector: "button:has-text('REVEAL')" })  // repeat per beat

// Type into textarea
playwright_fill({ selector: "textarea.w-full.bg-transparent", value: "{why_they_came}" })

// Click LOCK IN
playwright_click({ selector: "button:has-text('LOCK IN')" })

// Advance screen
playwright_click({ selector: "button:has-text('NEXT SCREEN')" })

// Click interstitials
playwright_click({ selector: "button:has-text('Pause to breathe')" })
```

Steps that have no programmatic equivalent and require human judgment:
- Deciding when the prospect has "owned the number" before advancing (Phase 3 decision rule).
- Interpreting buying signals ("That's a lot of value", leaning forward, silence) to decide whether to proceed to close or handle an objection.
- Responding to the coach's real-time questions (e.g., "Where does that 10000 number come from?") — these require live verbal interaction.
- Any captcha or authentication wall on the session URL.

## Decision rules

- **Reveal beats in strict order.** Never skip a REVEAL or advance the screen before all required beats on that screen are complete. Beats with a checkmark (✓) are done; those with a REVEAL button are pending.
- **Lock before advancing.** Any text field that has a LOCK IN button must be locked before clicking NEXT SCREEN. If a field is locked, an UNLOCK button appears — only unlock if the answer needs to be corrected.
- **Don't move on until they own the number.** On Phase 3 (The Pain), the coach instruction is explicit: "Watch for excuses. Reject them. Don't move on until they own the number." If the prospect hedges on the missed revenue figure, probe further before revealing the big total.
- **Interstitials are hold screens.** Use them whenever you need the prospect's view to pause without showing the current slide content. Always exit the