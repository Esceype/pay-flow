# ADR-007: Subscription lifecycle — linking, event ordering, and recording payments

## Context

Phase 4 adds recurring billing. Three things make subscriptions harder than
the one-time invoices of ADR-006:

1. **Stripe owns the state.** A subscription moves between `incomplete`,
   `active`, `past_due`, `canceled`, ... on Stripe's schedule (renewals,
   failed payments, dunning). Our row can only mirror it, from
   `customer.subscription.*` events.
2. **Those events can be applied in the wrong order.** Stripe does not
   guarantee delivery order, and the worker runs jobs concurrently
   (`WORKER_CONCURRENCY`), so even events delivered in order can be
   processed out of order. Applying `updated` after `deleted` would bring a
   canceled subscription back to life.
3. **The subscription doesn't exist when we need to refer to it.** Stripe
   creates it only when the customer completes Checkout, so the row the
   tenant sees ("awaiting checkout", with a link to share) has no Stripe
   subscription id yet.

Separately, ADR-006 left a naming question open: subscriptions make Stripe
generate `Invoice` objects, while "Invoice" already means something else
here.

## Decisions

### 1. Our row first, linked through metadata

`Subscription` is created intent-first, exactly like `Invoice` (ADR-006):
status `AWAITING_CHECKOUT`, a per-render `requestKey` against
double-submits, and a Checkout Session (`mode: "subscription"`) keyed
idempotently by the row id.

The row id is also written to `subscription_data.metadata`
(`payflowSubscriptionId`). Stripe copies that onto the subscription and
snapshots it onto every invoice the subscription generates. So *any* of the
first events — `customer.subscription.created`, `…updated`, or the first
`invoice.paid`, in whatever order they are processed — can find the row and
store `stripeSubscriptionId` on it. No processor depends on another one
having run first, and `checkout.session.completed` isn't needed for this at
all (subscription-mode sessions are ignored by the Checkout processor).

Metadata can be edited by the tenant in their own Stripe Dashboard, so it is
treated as untrusted. The metadata path only ever matches a row that
(a) belongs to the tenant the event came from and (b) isn't linked yet. It
can't re-point an existing link or touch another tenant's row. Once linked,
lookups go by `stripeSubscriptionId`, where a tenant mismatch means
corrupted data and fails the event (`UnrecoverableError`).

### 2. Ordering: timestamp guard, terminal states, and a tie-break

Each lifecycle event carries the full subscription object and Stripe's
`event.created`. `Subscription.lastEventAt` stores the `event.created` of
the last event applied. The rules:

| Situation | Outcome |
|---|---|
| Event status is terminal (`canceled`, `incomplete_expired`) | Applied unconditionally. It is the final state by definition |
| Row is already terminal | Nothing applies, whatever the timestamps |
| `event.created` later than `lastEventAt` (or nothing applied yet) | Applied |
| `event.created` earlier than `lastEventAt` | Discarded as stale |
| `event.created` equal to `lastEventAt` | **Tie**: re-read the subscription from Stripe and apply that |

The apply case is a single conditional
`UPDATE … WHERE status NOT IN (terminal) AND (lastEventAt IS NULL OR lastEventAt < :eventAt)`.
The check and the write are one atomic statement, so two events racing on
the same row are serialized by Postgres' row lock instead of by application
code. A discarded event is acknowledged as `PROCESSED`: discarding it was its
correct outcome.

**Why the tie-break exists.** `event.created` has one-second resolution and
events carry no sequence number. Two events from the same second can't be
ordered from the events themselves, and this is not an exotic case: a
subscription that starts `incomplete` and turns `active` as soon as its
first payment succeeds can emit `created` and `updated` within the same
second. With a strict `<`, whichever is
processed second is dropped; with `<=`, whichever is processed second wins.
Either is wrong half the time. So on a tie the worker asks the only party
that knows the order, with one API read.

**Options considered:**

- **A — always re-fetch the subscription and ignore the payload.** This is
  Stripe's general recommendation, and what `account.updated` does here.
  It costs one API call per event, ties webhook throughput to Stripe's API
  rate limits, and two concurrent fetches can still be written in the wrong
  order — it shrinks the race, it doesn't remove it.
- **B — process each subscription's events one at a time, in order** (BullMQ
  Pro groups, or `concurrency: 1`). Needs a paid feature or gives up
  parallelism. It also only fixes the worker's own reordering, not events
  that Stripe *delivers* out of order.
- **C — trust the payload, guard by `event.created`, re-fetch only on
  ties.** Chosen. No API call in the common case, correct in the ambiguous
  one, and the guard is a `WHERE` clause.

The rule itself is a pure function (`decideOrdering` in
`src/lib/subscription-state.ts`) with unit tests. The worker's hot path is
the conditional `UPDATE`, and the function classifies the misses. The
integration tests run the real SQL against Postgres: out-of-order events,
events processed concurrently, both tie orders, and a late update after a
cancellation.

### 3. Subscription payments are Transactions, not Invoices

`invoice.paid` for a subscription invoice writes a `Transaction` with
`subscriptionId` set. It never creates one of our `Invoice` rows — those
remain one-time, Checkout-backed records (ADR-006). So in this codebase:

- **Invoice** = something a tenant created to be paid once.
- **Transaction** = money that moved, for an `Invoice` *or* for a
  `Subscription` billing period.
- Stripe's subscription invoices are an input, not a model.

Only `invoice.paid` writes anything. A zero-amount invoice (trial, 100%
discount) writes nothing, because no money moved. `invoice.payment_failed`
has no processor: its effect on the subscription (`past_due`) already
arrives as `customer.subscription.updated`, and the "payment failed" email
belongs with the other notifications in Phase 6.

**Making the insert repeat-safe.** For a one-time invoice the `Transaction`
is guarded by the invoice's own `PENDING → PAID` transition. A subscription
payment has no such row to transition, so re-running the job — the classic
crash between "effect committed" and "job acknowledged" — would insert
twice. The textbook fix is a unique constraint on the event id, but
`Transaction` is designed to be range-partitioned by `createdAt`, and a
partitioned table can only enforce uniqueness on keys that include the
partition key.

Instead the processor uses an idempotent-consumer guard
(`claimWebhookEvent`): inside one database transaction it flips the
`WebhookEvent` to `PROCESSED` *conditionally* and inserts the `Transaction`
only if that update changed a row. The effect and the "already done" marker
commit together or not at all. A re-run, or two copies of the job running
at once, finds the event already claimed and writes nothing.

### 4. One writer for status

"Cancel" in the dashboard calls `stripe.subscriptions.cancel` and stops. The
row becomes `CANCELED` when the worker processes
`customer.subscription.deleted`, like every other status change. Writing
`CANCELED` from the request handler too would add a second writer racing the
first, for a few seconds of perceived speed. The page says the cancellation
was sent and will show once confirmed.

Discarding a subscription the customer never checked out for deletes the row
(there is no billing history to keep) — but only after its Checkout Session
has been expired in Stripe. Otherwise the customer could complete it a
moment later, and Stripe would hold a live, charging subscription whose
events point at a row that no longer exists.

### 5. Platform fee

`application_fee_percent` on the subscription (direct charges), from the
same `PLATFORM_FEE_BPS` as invoices. It is snapshotted on the row
(`applicationFeeBps`) at creation, so a later rate change doesn't apply
retroactively.

## Consequences

- A subscription's status in PayFlow lags Stripe by the webhook round trip
  (normally seconds). That is the consistency model working as designed:
  strongly consistent with the events that have been processed, never
  written optimistically.
- Subscriptions created directly in the tenant's Stripe Dashboard carry no
  PayFlow metadata and are not mirrored. Their events are acknowledged and
  ignored.
- `amount`, `currency`, `interval` and `intervalCount` are re-synced from
  every lifecycle event, since the tenant can change a price in Stripe.
  These are the inputs for the MRR read model in Phase 5.
- Every event that ties with the previously applied one costs one Stripe
  API read. If that ever matters at scale, the tie rate is the
  number to measure first.
- A Stripe subscription status this code doesn't know fails the event
  (`FAILED`, no retries) rather than being mapped to a guess.
- Not handled yet: refunds and disputes (no negative `Transaction`s),
  trial-specific UI, changing a subscription's price from PayFlow.
