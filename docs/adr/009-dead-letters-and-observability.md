# ADR-009: Dead letters, replay, and logs that can be followed

## Context

By Phase 5 the pipeline was correct when things went well and safe when
they went badly: an event that couldn't be processed was retried and then
marked `FAILED`. What it lacked was everything an operator needs
afterwards:

- **Why** did an event fail? The reason existed only in a log line, and in
  Bull Board for as long as Redis kept the job.
- **What now?** Nothing could put a failed event back through the
  pipeline except retrying its job in Bull Board — which works only while
  the job still exists.
- **What happened to event X?** One Stripe event passes through the webhook
  route, a queue, a processor, and then triggers a stats recompute and
  maybe an email, across two processes. The logs were free-text lines with
  no shared identifier.

(The other operational gap — events with no job at all — is the relay,
covered by the amendment to ADR-001.)

## Decisions

### 1. The event row carries its own failure

`WebhookEvent` gains `lastError` and `failedAt`.

- Every failed attempt writes `lastError`, including the ones that will be
  retried. The status stays `PROCESSING` then, so the event reads as "in
  flight", but a slow failure is visible before it becomes a dead letter.
- The final failure — retries exhausted, or an `UnrecoverableError` — also
  sets `FAILED` and `failedAt`. That is a dead letter.
- Success clears both.

This write never touches a `PROCESSED` event. A job can fail *after* its
event was processed, when only a follow-up signal (stats recompute, email)
could not be enqueued. The payment is recorded; marking the event failed
would be false.

The row was chosen as the place for this, over leaving it to BullMQ's
failed set, because the row is what survives: Redis can lose its data or
age the job out, and only the row knows which tenant an event belongs to.

### 2. Replay is a state change plus an enqueue

Replaying a dead letter flips it `FAILED → RECEIVED` with a conditional
`UPDATE`, removes the old failed job (BullMQ ignores an `add()` while a job
with the same id exists), and enqueues it again.

- **Safe by construction.** Every processor is idempotent (ADR-006,
  ADR-007), so replaying an event whose effects were partly or fully
  applied changes nothing it shouldn't. Replay needs no special cases.
- **Only dead letters can be replayed.** Anything else is done or in
  flight. The conditional update also makes two operators clicking at once
  replay it once.
- **If Redis is unreachable mid-replay**, the event is already `RECEIVED`,
  and the relay finishes the job either way: it enqueues it, or — if the
  old failed job is still there — marks it `FAILED` again, so a replay that
  didn't happen is visible rather than silently pending.

A redelivery of a dead-lettered event by Stripe does **not** replay it.
Whatever made it fail five times is presumably still true; an operator
decides when that has changed.

### 3. An operator page, next to Bull Board

`/admin/events` on the worker's admin server shows the count of events per
state, how many are stuck past the relay's threshold, and the dead letters
with tenant, error and a Replay button.

- It lives on the worker's admin server, behind the same Basic Auth as Bull
  Board, because it is the same kind of thing: an operator tool. Tenants
  have no use for other tenants' failures, and the app has no admin role to
  hang such a page on.
- Bull Board shows **jobs**; this page shows **events**. They usually
  agree. When they don't, the rows are right.
- State-changing requests from another site are refused using the
  browser's `Sec-Fetch-Site` header. Basic Auth credentials are attached by
  the browser to any request for the origin, including a form on another
  site posting to it.

### 4. Structured logs with a context that follows the work

Logs are one JSON object per line (`src/lib/logger.ts`): level, time, a
short stable message, and fields.

The part that matters is the context. Each unit of work wraps itself in
`withLogContext({ stripeEventId, webhookEventId, stripeAccountId, userId })`,
built on `AsyncLocalStorage`. Every line logged anywhere underneath —
across awaits, in a processor five calls down that was never handed an
id — carries those fields automatically.

`stripeEventId` is the correlation id. The webhook route logs under it, the
worker's job logs under it, and the stats recompute it triggers is passed
it (`causedBy`) and logs under it too. Searching for one event id returns
the event's whole story, from both processes.

**Options considered:** passing a logger or an id down through every
function signature (explicit, but it touches every signature and is
forgotten in exactly the deep helper that needed it); a logging library
such as pino (the standard choice, and a drop-in later — but the whole
requirement here is about forty lines, without a dependency that needs
care inside Next.js's bundling).

## Consequences

- A dead letter is no longer a dead end: it has a reason, a place it is
  listed, and a button.
- `lastError` holds a truncated message, not a stack. The stack is in the
  logs, under the same event id.
- The admin page has no pagination or filtering beyond "latest 100 dead
  letters". Past that, the right tool is a query — the index on
  `(status, receivedAt)` is there for it.
- There are still no metrics or alerts. "Dead letters > 0" and "stuck > 0
  for more than a few minutes" are the two conditions worth alerting on,
  and both are a single indexed count.
- Logging through `console` keeps stdout/stderr and Docker's log capture
  working, at the cost of pino-level throughput. That is not a limit this
  system is near.
