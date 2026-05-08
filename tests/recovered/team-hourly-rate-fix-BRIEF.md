---
kind: improvement
version: 1
description: Fix the "team hourly rate" field on Phase 3 / The Pain screen, which incorrectly defaults to $10,000 instead of a sensible per-hour value derived from user inputs.
---

# Fix incorrect default value in "Team's Hourly Rate" field on The Pain screen

## What's broken
On Phase 3 ("THE PAIN"), the field labelled **"WHAT'S AN AVERAGE HOUR OF YOUR TEAM'S TIME COST YOU?"** pre-populates with **$10,000** — an implausible hourly rate. The AI coach itself flagged this mid-session: "Where does that 10000 number come from?" The user had entered a team size of 10 people and a founder rate of $500/hr; neither of those inputs should produce $10,000 as a team hourly rate.

## Where to look
- **URL observed:** `https://v0-sales-presentation-app-orageagency.vercel.app/present/g57gfe04?rehearsal=1`
- **Element:** Input field labelled `WHAT'S AN AVERAGE HOUR OF YOUR TEAM'S TIME COST YOU?` displaying `$ 10000` with stepper arrows
- **Likely file (best guess):** The Pain phase component — search the repo for the visible string `"WHAT'S AN AVERAGE HOUR OF YOUR TEAM'S TIME COST YOU"` or `teamHourlyRate` / `team_hourly_rate`. In a Next.js App Router project this is likely `src/app/present/[id]/phases/ThePain.tsx` or a similarly named file under `src/components/phases/`.

## Current behavior
- User enters founder weekly hours = 40, founder hourly rate = $500, team weekly hours = 25.
- The "team's hourly rate" field auto-populates as **$10,000**.
- Screenshots confirm the value shown is `$ 10000` (see Phase 3 screenshot at ~8:07 timer).
- A later screenshot at ~8:18 shows the field correctly displaying `$ 25` after the user manually corrected it, confirming the field is editable but the default calculation is wrong.

## Desired behavior
The team hourly rate field should default to a reasonable per-hour cost — either:
1. A sensible hardcoded placeholder (e.g. `$25`), **or**
2. A computed default derived from team-related inputs already captured (e.g. total team payroll / team hours, if that data exists), **not** a value that multiplies or compounds incorrectly to reach $10,000.

The correct value the user accepted was **$25/hr**.

## Suggested change

Locate the default/initial value calculation for the team hourly rate field. The bug is almost certainly one of these:

**Option A — wrong variable used as seed value**

```ts
// BEFORE (likely culprit — accidentally using founder rate * team size, or similar)
const defaultTeamHourlyRate = founderHourlyRate * teamSize; 
// e.g. 500 * 10 = 5000, or some other mis-wired expression producing 10000

// AFTER — use a flat reasonable default, or a separate captured input
const defaultTeamHourlyRate = capturedTeamHourlyRate ?? 25;
```

**Option B — unit mismatch (monthly cost divided by wrong denominator)**

```ts
// BEFORE — dividing monthly cost by weeks instead of total monthly hours
const defaultTeamHourlyRate = teamMonthlyCost / teamWeeklyHours;
// e.g. 10000 / 25 would give 400, but if teamMonthlyCost itself is wrong...

// AFTER — ensure denominator is total monthly hours (weeklyHours * ~4.33)
const WEEKS_PER_MONTH = 4.33;
const defaultTeamHourlyRate = teamMonthlyCost / (teamWeeklyHours * WEEKS_PER_MONTH);
```

**Concrete instruction regardless of which option applies:**

In the Pain phase component, find the state initializer or `useEffect` that sets the team hourly rate field value. Verify what expression produces `10000` given inputs `{founderRate: 500, founderHours: 40, teamHours: 25, teamSize: 10}`. Fix the expression so it produces a per-hour labour cost (expected ~$25 based on the user's correction). Also check whether this same bad value propagates downstream into the `annualDead` / `$1,212,000/yr` calculation visible in the sidebar on the "IF WE CLOSE TODAY" screen — if the $10,000 figure fed into that math, the annual cost-of-pain figure will also be inflated and must be recalculated.

## Acceptance criteria
- [ ] With inputs `{founderRate: $500, founderHours: 40/wk, teamSize: 10, teamHours: 25/wk}`, the "team's hourly rate" field defaults to a value in a plausible per-hour range (e.g. $20–$100), not $10,000.
- [ ] The field remains manually editable; locking it in still works.
- [ ] The downstream "ANNUAL DEAD" figure shown in the sidebar (visible as `$1,212,000/yr`) is recalculated using the corrected team rate, not the $10,000 value.
- [ ] The AI coach question "Where does that 10000 number come from?" no longer triggers for normal inputs.

## Open questions
- Is `$10,000` a hardcoded fallback/default that was left in during development, or is it the result of a genuine calculation bug? Knowing this determines whether it's a one-line constant fix or a formula fix.
- Does the "missed revenue per month" field (`$10,000/mo` shown in the sidebar summary) share the same source value as the team hourly rate, or is it a separate input? If separate, confirm it is not also affected.