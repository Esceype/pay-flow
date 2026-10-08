# ADR-003: Stripe Connect multi-tenancy, and why `account.updated` bypasses the outbox

> **Status: amended (2026-09-30).** The two-endpoint split and the
> synchronous `account.updated` handler described below were built on a
> wrong assumption about Stripe's event scopes. See
> [Amendment](#amendment-2026-09-30-accountupdated-is-connected-accounts-scoped)
> at the end — the original text is kept as the record of the decision.

## Context

PayFlow is a platform, not a single-business billing tool: each `User` (tenant)
connects their own Stripe account. Two designs were available:

1. **Single platform Stripe account** — PayFlow's own account processes all
   payments; tenants are just rows in our database with no Stripe identity of
   their own.
2. **Stripe Connect (Standard accounts)** — each tenant onboards their own
   Stripe account via OAuth; PayFlow acts on their behalf using their
   `stripeAccountId`.

We chose (2).

Stripe Connect has three account types: Standard, Express, and Custom.
Express and Custom require us to build and maintain onboarding/KYC UI
ourselves and take on more compliance surface. Standard delegates onboarding
and KYC entirely to Stripe's own hosted flow — the right tradeoff for this
project, where the point is to demonstrate backend architecture, not build a
compliance-grade onboarding UI.

## Decision

- Every `User` has a nullable `stripeAccountId` and an `onboardingComplete`
  flag. Business actions (Checkout, Invoice creation) are gated on
  `onboardingComplete = true`.
- **Two separate Stripe webhook endpoints exist, with two separate signing
  secrets** (`STRIPE_WEBHOOK_SECRET` vs `STRIPE_CONNECT_WEBHOOK_SECRET` — see
  `.env.example` for the full rationale):
  - The **platform endpoint** receives only platform-level events. In this
    project that is exactly one event type: `account.updated`, which reports
    onboarding/capability status changes for a connected account.
  - The **Connect endpoint** receives every event from every connected
    account (payments, invoices, subscriptions — anything with an `account`
    field in the Stripe payload).
- **`account.updated` is handled synchronously, inline in the request
  handler — it does NOT go through the transactional outbox / BullMQ
  pipeline described in ADR-001.** Everything from the Connect endpoint does.
- Any Stripe API call made on a tenant's behalf must pass
  `{ stripeAccount: user.stripeAccountId }` explicitly. Omitting it sends the
  request to the platform account instead of the tenant's — this is a easy
  mistake with no compile-time guard, so it is called out here deliberately.
- `WebhookEvent.stripeAccountId` is resolved and stored **before** insert, so
  every downstream job/handler knows which tenant it belongs to without a
  second lookup.

## Why `account.updated` skips the outbox (options considered)

The outbox + queue pipeline exists to solve one problem: Stripe times out and
retries if we take too long to respond, and business logic (email, DB writes,
side effects) can be slow enough to hit that timeout. Two options:

- **A — route `account.updated` through the same outbox/BullMQ pipeline as
  payment events**, for architectural uniformity (one code path for all
  webhooks).
- **B — handle it synchronously, inline, with no queue.**

We chose **B**, because:

- It is not a payment event. There is no financial state, no risk of double
  processing money, and nothing to lose by handling it inline.
- The handler is a single, fast `UPDATE ... SET onboardingComplete = ...`
  — nowhere near Stripe's timeout budget even done synchronously.
- Routing it through the outbox anyway would add a queue hop and a worker
  round-trip for no reliability benefit, purely for uniformity — that's
  cost without a corresponding gain.
- It keeps the outbox/queue conceptually reserved for "payment-relevant, must
  survive a crash mid-processing" events, which is exactly the reliability
  guarantee the pipeline is there to provide (see ADR-001). Diluting that
  with non-payment traffic makes the pipeline's purpose less legible to a
  reviewer.

## Consequences

- Two webhook secrets must never be swapped — signature verification will
  simply fail closed if they are (a wrong secret rejects every event), so
  misconfiguration is loud rather than silent.
- If `account.updated` handling ever needs to do something slower (e.g.
  trigger a welcome email sequence), that piece should be dispatched to a
  queue at that point — the synchronous handler itself should stay limited to
  the fast status-flag update.
- `WebhookEvent.userId` is nullable to persist events for unrecognized
  `stripeAccountId`s (e.g. a webhook arriving before onboarding is
  reflected in our DB) rather than silently dropping them — see
  `prisma/schema.prisma`.

## Amendment (2026-09-30): `account.updated` is Connected-accounts scoped

### What was wrong

Stripe assigns every webhook endpoint one of two scopes — **Your account**
(`connect: false`) or **Connected accounts** (`connect: true`) — and
delivers each event to the endpoints of *its* scope. For a connected
account, `account.updated` is a **Connected accounts** event, as is
`account.application.deauthorized`
([Stripe docs: Connect webhooks](https://docs.stripe.com/connect/webhooks)).
So the "platform endpoint" above would never have received the
`account.updated` events it was built for in production. They would have
arrived on the Connect endpoint instead, been queued, found no processor,
and been marked `PROCESSED` — `onboardingComplete` would only ever have been
set once, by the OAuth callback, and never updated afterwards (Stripe
disabling charges, onboarding finished later, ...).

Local testing didn't catch it: `stripe trigger account.updated` without
`--stripe-account` fires the event on the **platform's own** account, which
*is* Your-account scoped, so it did reach the platform endpoint. Connected
account events need `stripe listen --forward-connect-to` and
`stripe trigger --stripe-account acct_...`.

### Decision

- **One webhook endpoint** (`/api/webhooks/stripe-connect`, Connected
  accounts scope). The platform endpoint and `STRIPE_WEBHOOK_SECRET` are
  removed — PayFlow consumes no Your-account events. If it ever needs one
  (e.g. `application_fee.*` for platform-revenue reporting), a
  Your-account endpoint gets added back for that.
- **`account.updated` goes through the outbox + BullMQ pipeline** like
  every other event, handled by a worker processor
  (`src/worker/processors/account.ts`). This reverses the "handle it
  synchronously" choice above, but its reasoning mostly carries over: it
  still isn't a payment event. What tips it is that it now arrives on the
  outbox endpoint anyway — a synchronous special case inside that route
  would mix two processing models in one handler, while the queue gives it
  retries and an audit trail for free.
- **Ordering needs no guard for `account.updated`**: the processor ignores
  the payload and re-reads the account from Stripe
  (`syncConnectAccountStatus`), so whichever job runs last writes the
  current state. It also skips the API call entirely for an account no
  longer linked to any user.
- **`account.application.deauthorized` is now handled** — the tenant
  disconnected PayFlow from their Stripe account, so the link is removed
  and business actions are gated again. This one *does* need an ordering
  guard: a deauthorization still queued after the tenant has already
  reconnected must not wipe the new link. `User.stripeConnectedAt` is set
  by the OAuth callback, and only a deauthorization whose `event.created`
  is later than it may unlink (`unlinkConnectAccount`).

