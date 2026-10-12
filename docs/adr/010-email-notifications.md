# ADR-010: Email notifications as follow-up jobs, sent at most once

## Context

Tenants should hear about two things without opening the dashboard: money
arriving, and a subscription payment failing.

Sending an email is unlike everything else the worker does. It is slow, it
depends on a third party that can be down or rate-limiting, and it cannot
be undone — a duplicate is not harmless, it is a second email in someone's
inbox. And it must never be able to interfere with recording a payment.

## Decisions

### 1. A third queue, fed after the event is done

After an event is fully processed, the worker enqueues a job on
`notifications` for the event types marked `notifies` in the processor
registry. A separate BullMQ worker consumes it.

This is the same shape as the revenue-stats signal (ADR-002): sent only
after the event's own effects are committed, never inside its transaction,
delivered at least once. If the email provider is down for an hour, emails
back up on their own queue and payments keep being recorded.

### 2. Decided from the database, not from the event

Whether an event is worth an email is decided by the notification job, from
what the event left behind:

- **Payment received** — only if a `Transaction` exists for this event id.
  Several Stripe events can mean "this was paid" (ADR-006), and only one of
  them records the payment. So the tenant gets one email per payment, not
  one per event, and nothing for a checkout that completed but hasn't paid.
- **Subscription payment failed** — for `invoice.payment_failed` on a
  subscription PayFlow manages, and only if the event's tenant owns it.
  This event has no processor (the resulting `past_due` arrives as
  `customer.subscription.updated`); it exists in the registry only because
  it is the one that says what failed, by how much, and when Stripe will
  try again.

Emails go to the tenant — the PayFlow user. Emailing the tenant's own
customers is deliberately out of scope: it would be sending on the
tenant's behalf, with sender-domain and consent questions this project
doesn't answer, and Stripe can already send customers receipts and failed
payment notices from the tenant's account.

### 3. Two guards against sending twice

"At least once" delivery plus "can't be undone" needs de-duplication, and
one layer isn't enough:

1. **A `Notification` row**, unique on `kind:stripeEventId`, is written
   *before* sending and marked `SENT` after. A job that runs again finds it
   already sent.
2. **The same key is the provider's idempotency key.** This covers the
   window the row cannot: the provider accepted the email, then the worker
   died before marking the row. The retry can't know that, so it sends
   again — with the same key, and Resend answers a repeated key with the
   original result instead of sending (keys are remembered for 24 hours).

This is the project's two-layer idempotency (ADR-006) applied to email: our
own record first, then the provider's key derived from it.

The row is also the audit trail. "Did we tell them?" has an answer that
doesn't depend on the provider's dashboard.

### 4. Failures: retry, give up, or skip

- **Provider unavailable or rate-limiting** (5xx, 429, a timeout): the job
  fails and BullMQ retries with backoff. The row stays `PENDING`.
- **A request the provider will never accept** (a rejected address, a bad
  API key): `UnrecoverableError`, no retries. Failed jobs on this queue are
  kept, and retrying one from Bull Board later is safe because of the
  guards above.
- **No provider configured**: the email is logged, the row is marked
  `SKIPPED`, and the job succeeds. Local development and CI run without an
  API key, and nothing leading up to an email behaves differently because
  of that. The placeholder value from `.env.example` counts as not
  configured.

### 5. A plain HTTP call

The client is one `fetch` to Resend's API with a timeout
(`src/lib/email.ts`), rather than an SDK. It is a single request, and it
keeps the module free of anything that would need lazy construction
(ADR-005).

## Consequences

- Emails trail the event by the length of a queue hop, and by however long
  the provider is unavailable.
- A notification skipped for lack of a provider is not sent later when one
  is configured.
- The provider's idempotency window is 24 hours. A job retried by hand
  after that, for a row still `PENDING`, would send. Rows only stay
  `PENDING` if every retry failed.
- Plain text only, two kinds, no per-tenant preferences and no unsubscribe.
  These are operational notices to the account owner; anything more is a
  product decision.
- The body is not stored — the row keeps recipient and subject, enough to
  know what was sent without keeping a second copy of customer data.
