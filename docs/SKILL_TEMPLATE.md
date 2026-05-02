---
name: refund-customer-stripe
version: 1
description: Issue a refund to a customer in Stripe and email confirmation.
---

# Refund a customer in Stripe

## Goal
Process a refund request from a customer support ticket. Verify
eligibility, issue the refund through the Stripe dashboard, and
send the customer a confirmation email from the support inbox.

## When to use
- A support ticket asks for a refund or a chargeback recovery.
- The customer's purchase is within the 30-day refund window.
- The order is paid (not pending or disputed).

## Inputs
- Customer email or Stripe customer ID
- Order ID or last-4 of card
- Refund reason (free text from ticket)

## Steps
1. Open dashboard.stripe.com → Customers → search by email.
   ![](step_1.png)
2. Click into the customer profile. In Recent payments, find the
   payment matching the order ID.
3. Click the payment row → Refund payment. If the order is older
   than 30 days, escalate to billing instead (do not proceed).
4. Refund amount: full unless the ticket specifies a partial.
   Reason dropdown: 'requested_by_customer'. Add internal note
   with the ticket ID.
5. Click Refund. Confirm the success toast appears.
   ![](step_5.png)
6. Switch to the support inbox → reply to the original ticket
   with the refund-confirmation template, filling {amount} and
   {arrival_estimate} (5–10 business days for cards).

## Decision rules
- Partial refunds: only when the ticket explicitly states an amount
  or a percentage. Otherwise refund the full payment.
- 30-day window: count from payment date, not order date.
- If the customer has 3+ refunds in 12 months, flag the account in
  the CRM but still process the refund.

## Edge cases
- Disputed payments: do not refund through Stripe; the dispute
  resolution handles it. Reply to the ticket explaining this.
- Subscription customers: cancel the subscription first, then refund
  the most recent invoice.

## Done when
- Stripe shows the payment status as 'Refunded' (full) or 'Partially
  refunded'.
- The support ticket has a customer-facing reply with the refund
  amount and arrival window.
- An internal note on the customer record references the ticket ID.
