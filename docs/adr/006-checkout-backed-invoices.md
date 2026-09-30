# ADR-006: Invoices backed by one-time Checkout Sessions, created intent-first

## Context

Phase 3 lets a tenant bill their own customers. Two Stripe building blocks
fit "send a customer something to pay":

- **Stripe Invoicing** (`Invoice` objects): hosted invoice page with no
  expiry, Stripe-sent invoice emails and reminders, native invoice numbering.
- **Checkout Sessions** (`mode: "payment"`): a hosted payment page for one
  payment. It expires (24h by default) and has no invoice semantics of its
  own.

Whichever is chosen, creating one means calling Stripe from a request
handler, and that call can succeed while our own database write fails, or
be sent twice (double-click, retry after a timeout).

## Decision: our own `Invoice` row + a one-time Checkout Session

`Invoice` is PayFlow's own record. Each one is paid through a Checkout
Session created on the tenant's connected account (a direct charge).
`Invoice.stripeInvoiceId` stays unused.

Chosen because it keeps the source of truth for "what is owed" in our
database and makes the webhook-driven state machine explicit in our code,
which is the part this project exists to demonstrate. Stripe Invoicing
would hand most of that lifecycle to Stripe. The cost is handling things
Invoicing would do for us — expiry, and async payment methods — which is
covered below.

**Revisit before Phase 4:** subscriptions produce Stripe `Invoice` objects
(`invoice.paid`, `invoice.payment_failed`) no matter what. From then on,
"invoice" means two different things in this codebase: our one-off
`Invoice` rows and Stripe's subscription invoices. Phase 4 must name them
apart (e.g. record subscription payments as `Transaction`s against the
`Subscription`, not as `Invoice` rows).

### State machine (worker, `src/worker/processors/checkout-session.ts`)

| Event | Invoice |
|---|---|
| `checkout.session.completed`, `payment_status` = `paid` / `no_payment_required` | `PENDING -> PAID` + one `Transaction` |
| `checkout.session.completed`, `payment_status` = `unpaid` | stays `PENDING` (async method still settling) |
| `checkout.session.async_payment_succeeded` | `PENDING -> PAID` + one `Transaction` |
| `checkout.session.async_payment_failed` | `PENDING -> FAILED` |
| `checkout.session.expired` | `PENDING -> EXPIRED` |

Every transition is a conditional `UPDATE ... WHERE status = 'PENDING' AND
stripeCheckoutSessionId = <session>`, never read-then-write. A redelivered
event matches no rows. Two concurrent "paid" events for one session are
serialized by Postgres' row lock, and the second re-checks its `WHERE`
after the first commits. Either way, exactly one `Transaction` is written.
The session-id condition means an event for a replaced session can't
touch the invoice. Verified with three concurrent "paid" events for the
same session: one `Transaction`.

The processor also checks that the event's tenant owns the invoice. A
mismatch throws `UnrecoverableError`, which marks the event `FAILED`
immediately without retries, instead of crediting the wrong tenant.

`EXPIRED` and `FAILED` invoices get a **new** Checkout Session through
"New payment link". The session id changes and the invoice returns to
`PENDING`. `getOrCreatePaymentLink()` reuses a still-open session, and
refuses to create a second session while a completed one's payment may
still be settling.

### Intent-first writes and outbound idempotency

CLAUDE.md's second idempotency layer (Stripe idempotency keys on our own
calls), applied to the request handlers:

1. **Write our row first**, with no Stripe id yet: `Customer`, or
   `Invoice(PENDING)`.
2. **Call Stripe with an idempotency key derived from that row's id**:
   `customer-<id>`, `invoice-<id>-after-<previous session id | none>`.
3. **Store the returned Stripe id** with a compare-and-set on the value
   step 2 started from.

If step 2 or 3 fails, we have a row without a Stripe counterpart, never a
Stripe object with nothing pointing at it. The same code path finishes the
job later: `ensureStripeCustomer()` runs again before the customer's first
invoice, and "Get payment link" creates a missing session. Repeating step 2
with the same key returns the same Stripe object instead of a duplicate.

Double-submitted forms are stopped one step earlier. The invoice form
carries a per-render `requestKey` (unique on `Invoice`), so a second
submission hits the constraint and continues with the first submission's
invoice. `Customer` gets the same protection from `@@unique([userId, email])`.

### Other decisions made with this

- **Platform fee**: `application_fee_amount` on the direct charge, as
  `PLATFORM_FEE_BPS` basis points of the amount, rounded down.
  Snapshotted onto `Invoice.applicationFeeAmount` at creation, so a
  later rate change never alters an existing invoice.
- **Currencies**: an allowlist (USD, EUR, GBP) — all two-decimal, so
  "× 100" is correct, each with Stripe's minimum charge enforced up
  front. Zero-decimal currencies (JPY, ...) would need per-currency
  exponent handling. That is out of scope and ruled out by the allowlist.
- **Customers with invoices can't be deleted**: an app-level check plus
  `onDelete: Restrict` on `Invoice.customer` / `Subscription.customer`.
  Billing history is never removed as a side effect.
- **Checkout redirects go to public `/pay/success` and `/pay/canceled`
  pages**, not the dashboard. The payer is the tenant's customer and has
  no PayFlow login. Those pages show no invoice data, and the redirect
  itself changes nothing. Only the webhook does.

## Consequences

- A `PENDING` invoice with a null `stripeCheckoutSessionId` is a normal,
  recoverable state (session creation failed), not corruption.
- Stripe idempotency keys expire after 24h. That is well beyond the
  double-click/retry window they protect here.
- Customer data can drift in one direction only: deleting a customer that
  has no invoices removes our row first, then the Stripe customer. If the
  Stripe delete fails, an orphaned Stripe customer with no charges
  remains. This is logged and accepted.
