---
name: approve-low-value-refund
version: 1
description: Approve and close refund tickets under $200 that qualify for the no-questions-asked policy
---

# Approve Low-Value Refund Ticket

## Goal
Process a refund request from the Triage queue by approving it when the amount is under the $200 threshold and the return reason is standard (e.g., wrong size), then mark the ticket as done to close it out.

## When to use
- A refund ticket appears in the Triage queue
- The refund amount is under $200
- The customer's return reason is a common/standard reason (e.g., "wrong size")
- There are no fraud signals on the customer's account

## Inputs
- Access to the Orage CRM Triage queue
- Knowledge of the refund threshold ($200)
- Ability to assess whether the return reason qualifies for no-questions-asked policy
- Ability to check for fraud signals on the customer account (if applicable)

## Steps
1. Navigate to the Triage queue in Orage CRM. The page displays a list of tickets with ticket ID, customer name, refund amount, and return reason.

2. Identify the ticket to process. Each ticket card shows the ticket number (e.g., #A101), customer name (e.g., Maria Santos), dollar amount (e.g., $147.00), and the stated reason in quotes (e.g., "wrong size").

3. Verify the refund amount is under the $200 threshold. If the amount shown is less than $200, the no-questions-asked policy applies.

4. Confirm the return reason is a standard/common reason that qualifies for automatic approval (e.g., "wrong size" is acceptable).

5. Check that there are no fraud signals on the customer's account. If the account appears clean, proceed with approval.

6. Click the "Approve refund" button (green button on the left side of the ticket card) to approve the refund.

7. Click the "Mark done" button (white/outlined button next to the Approve refund button) to close the ticket.

## Decision rules
- Refunds under $200 qualify for the no-questions-asked policy and can be approved without escalation
- Common return reasons like "wrong size" are automatically approvable
- Always approve the refund before marking the ticket as done (the refund action must be completed first)
- If fraud signals are present on the account, do not auto-approve (escalate instead)
- If the refund amount is $200 or above, this skill does not apply—use a different approval workflow

## Edge cases
None observed.

## Done when
The ticket has been approved (Approve refund clicked) and closed (Mark done clicked), removing it from the active Triage queue or updating its status to completed.