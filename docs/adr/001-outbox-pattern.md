# ADR-001: Transactional outbox for the Connect webhook pipeline

## Context

Stripe times out and retries a webhook delivery if the endpoint doesn't
respond within roughly 10–20 seconds. If business logic (DB writes, email,
analytics updates) runs synchronously inside the webhook handler and is slow
enough to hit that timeout, Stripe re-delivers the same event — and if the
first attempt actually finished its side effects just after Stripe gave up
waiting, that re-delivery causes duplicate processing (double-counted
revenue, duplicate emails, etc.).

The Connect webhook endpoint (`/api/webhooks/stripe-connect`) receives every
payment-relevant event from every connected account, so this endpoint —
unlike the platform endpoint's `account.updated` (ADR-003, handled
synchronously) — needs a way to acknowledge receipt fast and do the real
work separately.

## Decision: idempotent insert + idempotent enqueue, not a literal cross-system transaction

The plan describes this as "insert the event and enqueue the job in one
transaction." Worth being precise about what that actually means in this
stack, because it does **not** mean a single ACID transaction spanning
Postgres and Redis — Postgres transactions can't cover a Redis write, and
pretending otherwise would be the kind of hand-wave a reviewer should catch.
What actually happens:

1. **Insert `WebhookEvent`** (Postgres), keyed by `stripeEventId` (`@unique`).
   This single insert is atomic on its own — that's what actually
   guarantees "we've durably recorded that we saw this event" before
   anything else happens. Insert-first, not check-then-insert: catching the
   unique-constraint violation (`P2002`) avoids a TOCTOU race if Stripe ever
   delivers the same event concurrently on two connections (same pattern as
   ADR-003's platform handler).
2. **Enqueue a BullMQ job** (Redis) with `jobId` set to the `WebhookEvent`
   row's id. BullMQ refuses to create a second job with a `jobId` that's
   already active/waiting in the queue — this makes the *enqueue* step
   idempotent on its own terms, independent of the Postgres insert.
3. **Return 200** to Stripe.

The gap this leaves: if step 2 fails after step 1 succeeds (Redis down, or
the process crashes between them), there's a `WebhookEvent` row recorded
with no corresponding job — nothing will ever pick it up. Two ways to close
that gap were considered:

- **A — a separate outbox-relay process** that polls Postgres for
  `WebhookEvent` rows stuck in `RECEIVED` past some threshold and re-enqueues
  them. This is the textbook fix and is Phase 4/6 scope ("graceful
  degradation if Redis unavailable" is already on that phase's checklist)
  — it's a real piece of infrastructure, not a few lines.
- **B — let the enqueue failure surface as a non-200 response**, so Stripe's
  own retry mechanism becomes the recovery path. On retry, the insert hits
  the existing row (same `stripeEventId`), and the handler attempts to
  enqueue again — same idempotent `jobId`, so a second successful enqueue
  attempt is safe even if the first one partially succeeded.

**Chose B for now.** It's a few lines instead of a new relay process, and it
correctly closes the gap for the common failure mode (a single transient
Redis hiccup) by piggybacking on infrastructure Stripe already provides
(webhook retries with backoff, for up to three days). It does **not** cover
Redis being down for longer than Stripe keeps retrying, or the platform
being unreachable during Stripe's retry window entirely — that residual risk
is accepted for now and is exactly what Phase 4/6's relay process is for.
This tradeoff is worth re-examining before this pipeline handles anything
where "up to a few days of retries" isn't an acceptable recovery window.

## Consequences

- The webhook handler must check `WebhookEvent.status` before deciding
  whether to enqueue: if a prior attempt already reached `PROCESSED`, skip
  enqueueing and return 200 (true duplicate delivery, already handled). If
  the row exists but isn't `PROCESSED` yet (fresh, or a prior enqueue
  failed), attempt to enqueue again — safe because of the `jobId` dedup.
- `WebhookEvent.payload` (raw JSON) is the source of truth for processors —
  BullMQ job data carries only `{ webhookEventId }`, not the full Stripe
  payload, so Redis never holds a second copy of payment data and processors
  always read the one durable record.
- A job that exhausts all retry attempts (BullMQ `attempts: 5`, exponential
  backoff — `src/lib/queue.ts`) marks its `WebhookEvent` row `FAILED` via the
  Worker's `failed` event listener (`src/worker/index.ts`) — visible both in
  Bull Board (which already surfaces failed jobs since
  `removeOnFail: false`) and by querying `WebhookEvent` directly. A proper
  dead-letter UI beyond that is still Phase 4/6 scope.
