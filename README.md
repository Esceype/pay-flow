# PayFlow

[![CI](https://github.com/Esceype/pay-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/Esceype/pay-flow/actions/workflows/ci.yml)

Stripe Connect subscription & invoicing SaaS. Multi-tenant: each `User`
(tenant) connects their own Stripe account via Stripe Connect (Standard
accounts) — PayFlow itself never holds tenant funds.

Architecture rationale and phased build plan:
[`stripe-saas-senior-architecture-plan.md`](./stripe-saas-senior-architecture-plan.md).
Individual decisions are recorded in [`docs/adr/`](./docs/adr/) as they're made.

**Status: Phase 7 (refunds) complete.**
- Phase 0 — infra: Docker Compose, Prisma schema, BullMQ, Bull Board.
- Phase 1 — auth + Stripe Connect onboarding.
- Phase 2 — webhook pipeline: signature verification, idempotent outbox
  insert + enqueue, worker dispatch, retry/backoff, dead-letter status.
- Phase 3 — customers and one-time invoices on the tenant's connected
  account, paid via Checkout, with the outcome applied by the worker from
  Stripe's webhooks (ADR-006).
- Phase 4 — subscriptions mirrored from Stripe's lifecycle events, safe
  against out-of-order and duplicate processing (ADR-007), plus the test
  suite and CI.
- Phase 5 — MRR, churn and lifetime revenue as an asynchronously
  maintained read model with a Redis cache in front (ADR-002), and
  token-bucket rate limiting (ADR-008).
- Phase 6 — the outbox relay (events are accepted and processed even
  through a Redis outage), dead letters with a reason and a replay button,
  structured logs correlated by Stripe event id (ADR-009), and email
  notifications sent at most once (ADR-010).
- Phase 7 — refunds, full or partial, requested from PayFlow or made in
  the tenant's Stripe Dashboard, mirrored from Stripe's refund events into
  an append-only ledger; lifetime revenue becomes net of refunds (ADR-011).

Next: deployment. Disputes are out of scope for now.

## Architecture at a glance

```
Next.js app  ──┐
               ├──▶ PostgreSQL (Prisma)
               ├──▶ Redis db0 (BullMQ queues) / db1 (cache, rate limiter)
               └──▶ Stripe API (Connect, Checkout, Billing)

Worker (separate Node.js process)
  ├─ BullMQ Worker: `webhook-events`  — Stripe events → invoices,
  │                                      subscriptions, refunds, transactions
  ├─ BullMQ Worker: `revenue-stats`   — recomputes each tenant's revenue
  │                                      read model after those change
  ├─ BullMQ Worker: `notifications`   — emails the tenant (Resend)
  ├─ Outbox relay (timer)             — re-enqueues events that have no
  │                                      job, reconciles the rest
  └─ Express admin server (:3001), HTTP Basic Auth on /admin
       ├─ /healthz            — unauthenticated, for container healthchecks
       ├─ /admin/queues       — Bull Board: jobs, per queue
       └─ /admin/events       — webhook events: states, dead letters, replay
```

How the data moves, and what is allowed to lag:

```
Stripe ─▶ webhook route ─▶ WebhookEvent row ─ ─ ▶ webhook-events queue
            answers 200 once        │   (fast path; if Redis is down the
            the row is stored       │    relay enqueues it a minute later)
                                    ▼
              strongly consistent ◀── worker: invoice / subscription status
              (same transaction)             + Transaction
                                                      │ signals (at least once)
                              ┌───────────────────────┴──────────────┐
                              ▼                                      ▼
   eventually consistent ◀── recompute                  email the tenant, once
   (seconds behind)          MaterializedRevenueStats   (Notification row +
                             └▶ delete the cache key     provider idempotency key)

dashboard ─▶ Redis (30s TTL) ─miss─▶ MaterializedRevenueStats (by primary key)
```

Four independent services in Docker Compose: `postgres`, `redis`, `app`,
`worker`. The app and worker scale independently — the worker never runs
inside the Next.js process.

## Running locally

### With Docker Compose (recommended — matches production topology)

```bash
cp .env.example .env   # fill in BULL_BOARD_PASSWORD at minimum
docker compose up -d --build
```

- App: http://localhost:3000
- Worker health: http://localhost:3001/healthz
- Operator pages (Basic Auth: `BULL_BOARD_USER` / `BULL_BOARD_PASSWORD`):
  - Bull Board, jobs per queue: http://localhost:3001/admin/queues
  - Webhook events and dead letters: http://localhost:3001/admin/events

Apply the migrations to the containerized Postgres:

```bash
npx prisma migrate deploy
```

(Reads `DATABASE_URL` from `.env`, which points at `localhost:5433` — see
"Port conflicts" below for why it isn't 5432.)

### Without Docker (app/worker on host, still need Postgres + Redis)

```bash
cp .env.example .env         # DATABASE_URL/REDIS_URL should point at localhost
npm install
npx prisma migrate deploy
npm run dev                  # Next.js app
npm run worker:dev           # in a second terminal — BullMQ worker + Bull Board
```

## Using the app

1. Visit http://localhost:3000 — redirects to `/login`.
2. `/signup` to create a `User` (email + password, hashed with
   `crypto.scrypt` — see `docs/adr/004-auth-and-proxy-gate.md`), then log in.
3. `/dashboard` shows Connect status and a "Connect Stripe" button
   (`/api/connect/start`) if not yet connected. Customers and invoices
   unlock once Stripe reports the account can accept charges
   (`onboardingComplete`).
4. `/dashboard/customers` — add a customer (created on your connected
   Stripe account too). Customers with invoices can't be deleted.
5. `/dashboard/invoices` — create an invoice, share the Checkout link with
   the customer. Its status moves `PENDING -> PAID` (or `FAILED` /
   `EXPIRED`) when the worker processes Stripe's webhook, never from the
   checkout redirect itself. Expired or failed invoices get a "New payment
   link".
6. `/dashboard/subscriptions` — create a subscription (price, currency,
   monthly or yearly) and share its Checkout link. It stays
   `AWAITING CHECKOUT` until the customer subscribes; from then on its
   status, renewals and cancellation mirror Stripe's lifecycle events.
   "Cancel" asks Stripe to cancel — the row shows `CANCELED` once Stripe's
   webhook confirms it.
7. `/dashboard/payments` — every payment received (invoice or
   subscription), with its refunds. "Refund" takes any amount up to what
   is left to refund, and sends it to Stripe on your account; the refund
   shows `SUCCEEDED` once Stripe's webhook confirms it, not when the button
   returns. Refunds you make in your own Stripe Dashboard appear here too,
   marked "made in Stripe" ([ADR-011](./docs/adr/011-refunds.md)).
8. Back on `/dashboard`, the **Revenue** panel shows MRR, active
   subscriptions, 30-day churn, lifetime revenue (net of refunds) and
   refunds, per currency. These come from a read model the worker
   recomputes in the background, so they can trail the lists by a few
   seconds — the panel says when they were computed.

Dashboard actions are rate-limited per tenant (a burst of 20, then one
every two seconds), and login and signup per client address; going over
shows a "too many requests" message rather than an error page
([ADR-008](./docs/adr/008-rate-limiting.md)).

There is **no `proxy.ts` auth gate** — each protected route/page checks the
session itself. See `docs/adr/004-auth-and-proxy-gate.md` for why (short
version: `next-auth@5` beta doesn't yet work with Next 16's `proxy.ts`
rename).

## Testing with Stripe locally

Everything goes through **one webhook endpoint**,
`/api/webhooks/stripe-connect`, which must be scoped to **Connected
accounts** — `account.updated` for a connected account is a
Connected-accounts event too, not a platform one (see the amendment in
[`docs/adr/003-stripe-connect-multitenancy.md`](./docs/adr/003-stripe-connect-multitenancy.md)).

### One-time Stripe setup (test mode)

1. **Connect → Settings**: enable Standard accounts (OAuth), copy the
   `client_id` into `STRIPE_CONNECT_CLIENT_ID`, and register
   `http://localhost:3000/api/connect/callback` as a redirect URI.
2. **Developers → API keys**: copy the test secret key into
   `STRIPE_SECRET_KEY`.
3. Optional: set `PLATFORM_FEE_BPS` (e.g. `250` = 2.5%) to take a platform
   fee from each invoice payment.

### Forward webhooks with the Stripe CLI

```bash
stripe listen --forward-connect-to localhost:3000/api/webhooks/stripe-connect
```

`--forward-connect-to`, **not** `--forward-to` — the latter only forwards
events of your own (platform) account, and would silently miss every event
from connected accounts. Put the `whsec_...` it prints into
`STRIPE_CONNECT_WEBHOOK_SECRET`, then restart the app container
(`docker compose up -d --force-recreate app`) so it picks the value up.

**The CLI must listen on the same Stripe account as `STRIPE_SECRET_KEY`.**
If the key belongs to a sandbox but `stripe login` picked your main
account, `stripe listen` runs happily and forwards nothing: no events in
`WebhookEvent`, no signature errors, invoices stuck on `PENDING`. Compare
`stripe config --list` (`account_id`) with the platform account, and either
`stripe login` into the right one or pass the key explicitly:
`stripe listen --api-key sk_test_... --forward-connect-to ...`. The
`whsec_...` secret differs per account, so update it after switching.

For a deployed environment, create the endpoint in the Dashboard with
**Events from: Connected accounts** and enable at least the events the
worker handles (`src/worker/processors/index.ts`): `account.updated`,
`account.application.deauthorized`, `checkout.session.completed`,
`checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`,
`customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`,
`refund.created`, `refund.updated`, `refund.failed`.

### End-to-end: connect, invoice, pay

1. Log in, "Connect Stripe", and finish onboarding the test account in
   Stripe's hosted flow — the dashboard only unlocks invoicing once Stripe
   reports `charges_enabled`. If the linked account still has outstanding
   requirements (e.g. `individual.id_number`), the dashboard shows "Finish
   Stripe onboarding": it opens Stripe's hosted onboarding via an Account
   Link (`/api/connect/onboarding`) — re-running OAuth would only re-link
   the same account without collecting anything. Fill it in with
   [test values](https://docs.stripe.com/connect/testing); on return
   (`/api/connect/return`) the status is re-read from Stripe, and the
   `account.updated` webhook does the same through the worker.
2. Add a customer, create an invoice, open the payment link, pay with
   card `4242 4242 4242 4242` (any future expiry / CVC).
3. The payer lands on the public `/pay/success` page; within a moment the
   invoice shows `PAID` on `/dashboard/invoices`, a `Transaction` row
   exists, and the job is visible in Bull Board
   (http://localhost:3001/admin/queues).
4. Duplicate delivery: resend that event with
   `stripe events resend <evt_id> --account <acct_id>` (`--account`, not
   `--stripe-account`) — the endpoint acks it, nothing is applied twice.
   The same command recovers an event that was missed while no listener
   was running.

### End-to-end: subscribe, renew, cancel

1. `/dashboard/subscriptions` → pick a customer, a price, "Create
   subscription"; open the Checkout link and subscribe with card
   `4242 4242 4242 4242`.
2. Within a moment the row turns `ACTIVE` with a "current period ends"
   date, and the first payment exists as a `Transaction` linked to the
   subscription (not as an invoice on `/dashboard/invoices`).
3. "Cancel" → the page says the cancellation was sent; the row still reads
   `ACTIVE` until Stripe's `customer.subscription.deleted` is processed,
   then `CANCELED`.
4. A subscription nobody completed Checkout for can be removed with
   "Discard" — its Checkout Session is expired in Stripe first, so the
   link can't be used afterwards.

Resending the subscription's `invoice.paid` event
(`stripe events resend <evt_id> --account <acct_id>`) is a duplicate
delivery and must *not* add a second `Transaction`.

### End-to-end: refund

1. Pay an invoice (above), then on `/dashboard/payments` refund part of
   it, e.g. `5.00` of `20.00`. The page says the refund was sent; within a
   moment it reads `−5.00 USD SUCCEEDED · from PayFlow`, the form offers
   the remaining `15.00`, and the Revenue panel's lifetime figure drops by
   5.00 with 5.00 under Refunds.
2. In the Stripe Dashboard (the connected account), refund another part of
   the same payment. It appears under the payment as "made in Stripe".
3. A refund that fails: pay an invoice with card `4000 0000 0000 5126`
   and refund it. Stripe first reports it `succeeded`, then `failed` —
   the refund ends `FAILED` with Stripe's reason, the ledger keeps the
   debit plus a reversal (lifetime revenue goes back up), and the tenant
   gets one "Refund failed" notification (`SKIPPED` without an API key).

To fire a Connect-scoped test event without a real checkout:
`stripe trigger --stripe-account acct_... checkout.session.completed`. It
reaches the worker and no-ops (`no Invoice for session ...`) — that session
wasn't created by PayFlow.

### Without Stripe: signed synthetic events

`scripts/send-test-event.mjs` sends an event signed with
`STRIPE_CONNECT_WEBHOOK_SECRET`, which the endpoint verifies exactly as it
would Stripe's. It carries no real Stripe object, so it exercises the
pipeline rather than the business logic:

```bash
node scripts/send-test-event.mjs customer.created
node scripts/send-test-event.mjs customer.created --id evt_same     # run twice: a duplicate
node scripts/send-test-event.mjs account.application.deauthorized --no-account
```

The last one cannot be processed and becomes a **dead letter**.

### Operating it: outages, dead letters, logs

- **Redis down.** Stop it (`docker compose stop redis`) and send an event:
  the endpoint still answers 200, about two seconds later, and the event
  is stored as `RECEIVED`. Start Redis again and the event is processed —
  by its own delayed enqueue if the app kept running, otherwise by the
  relay, which re-enqueues events that have had no job for five minutes
  ([ADR-001, amended](./docs/adr/001-outbox-pattern.md)).
- **Dead letters.** http://localhost:3001/admin/events lists events that
  could not be processed, each with its tenant and the reason, and a
  Replay button. Replaying is always safe: every processor is idempotent
  ([ADR-009](./docs/adr/009-dead-letters-and-observability.md)).
- **Logs.** Both processes write one JSON object per line, and everything
  logged while handling an event carries that event's `stripeEventId`:

  ```bash
  docker compose logs app worker | grep evt_1UPesxJExQH0uEllgOb3dfrn
  ```

  returns its receipt, its processing, the stats recompute it caused and
  the notification about it.
- **Emails.** A paid invoice or subscription, a failed subscription
  payment and a failed refund notify the tenant by email, at most once per
  payment or refund ([ADR-010](./docs/adr/010-email-notifications.md)). Without a
  `RESEND_API_KEY` nothing is sent: the notification is recorded as
  `SKIPPED` and logged.

## Tests

```bash
npm test                   # unit tests: pure logic, no infrastructure
npm run test:integration   # webhook route + worker against real Postgres and Redis
npm run test:all           # both
```

CI ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)) runs lint,
typecheck and both test suites on every push, then builds the app with the
database URL removed — the Docker image is built without runtime
environment variables, and that step keeps it possible
([ADR-005](./docs/adr/005-lazy-env-and-client-init.md)).

The **unit tests** cover the rules that are pure functions: the
subscription ordering decision, the mapping from Stripe's objects to ours
(in both API payload shapes), amount parsing and platform-fee rounding,
which Checkout event means what for an invoice, the refund state graph
(forward only, no cycles) and the refundable amount, the logger's context
propagation, and the email client's request and error classification.

The **integration tests** need `docker compose up -d postgres redis`. They
create and migrate their own `payflow_test` database (and refuse to run
against anything not named `*_test`) and use Redis logical database 15,
then drive the real webhook route handler and the worker's real job
handlers. Postgres and Redis are not mocked, because the guarantees being
tested live there — conditional updates, row and advisory locks, a Lua
script. The only fakes are the job queues and, where a test is about
sending, the email provider. What they pin down:

- a webhook delivered twice is stored once and processed once
- an event is accepted with Redis down or hanging, then delivered by the
  relay and processed exactly once; an event that can't be stored is not
  accepted
- the relay leaves in-flight events alone and marks an event failed when
  its job failed for good but nobody recorded it
- a dead letter keeps its reason, can be replayed once and only while it
  is a dead letter, and a processed event is never marked failed
- the tenant gets one email per payment however often the job runs, never
  another tenant's, and none for a checkout that hasn't paid
- subscription events processed out of order, concurrently, or within the
  same second still converge on the right state
- a late `updated` can't resurrect a canceled subscription
- `invoice.paid` arriving before any lifecycle event still finds its
  subscription
- a job that runs again after its effects were committed writes nothing
- one tenant's events can't reach another tenant's rows
- revenue figures: MRR normalization, currencies kept apart, the churn
  window, and that the same recompute run any number of times gives the
  same rows
- a recompute waits for another one of the same tenant, then reads what
  was committed in the meantime
- the dashboard shows new figures right after a recompute, not after the
  cache TTL; with Redis unreachable it reads Postgres instead
- the token bucket: burst, refill, cap, no token spent twice under
  concurrency, and requests allowed when Redis is unreachable
- refunds: two full refunds requested at the same moment refund once, a
  double submit refunds once, partial refunds stop at the amount paid; a
  refund Stripe rejects frees its amount, one Stripe never answered keeps
  it and is retried under the same idempotency key
- refund events in any order, duplicated or concurrent, end in Stripe's
  final state with one debit — and a reversal when a refund fails after
  succeeding, even when the two events are processed at the same moment
- refunds made in the Stripe Dashboard are matched to their payment
  through Stripe; another tenant's metadata can't claim a refund; revenue
  is net of refunds; a failed refund is emailed once, though two events
  report it

Races are made deterministic where it matters: the test holds the row
lock itself and lines the competing transactions up behind it, so the
interleaving that breaks a missing lock happens on every run.

Each of these was checked the other way round too: remove the guarantee
from the code, and the corresponding test fails.

## Port conflicts

Docker Compose publishes Postgres on host port **5433**, not the default
5432. If you have a native/local PostgreSQL install (common on dev
machines), it likely already owns 5432 — and on Windows, two processes can
end up both `LISTENING` on the same port with no bind error. Traffic then
gets routed to whichever one wins the OS's port arbitration, silently. That
reads as "authentication failed" against the container, when you're actually
talking to the other Postgres entirely. 5433 avoids the ambiguity outright.
The `app`/`worker` containers are unaffected either way — they reach
Postgres over the internal Docker network on port 5432, never through the
host-published port.

If you hit an analogous symptom for Redis (6379), check
`netstat -ano | findstr :6379` (or `netstat -ano | grep 6379` in Git Bash)
for more than one `LISTENING` PID and cross-reference with
`Get-Process -Id <pid>` in PowerShell.

## Why Prisma 7 needs `prisma.config.ts`

Prisma 7 removed `datasource.url` from `schema.prisma` — the CLI reads the
connection string from `prisma.config.ts` (loaded via `dotenv/config`, since
Prisma no longer auto-loads `.env` either), while `PrismaClient` itself is
constructed with an explicit `@prisma/adapter-pg` driver adapter in
`src/lib/prisma.ts`. These are deliberately two separate code paths (CLI vs.
runtime), not an oversight.

## Environment variables

See [`.env.example`](./.env.example) — every variable is documented inline.
There is a single Stripe webhook secret, `STRIPE_CONNECT_WEBHOOK_SECRET`
(an earlier platform endpoint with its own `STRIPE_WEBHOOK_SECRET` was
removed — see the ADR-003 amendment).

`NEXTAUTH_SECRET` and `NEXTAUTH_URL` are required (session JWT signing, and
the base URL for the Connect `redirect_uri` and Checkout redirects) —
`next dev` / `docker compose up` will fail fast with a clear Zod error if
either is missing. Note that reading them happens lazily at request time,
not at module import — see
[`docs/adr/005-lazy-env-and-client-init.md`](./docs/adr/005-lazy-env-and-client-init.md)
for why that distinction mattered enough to be its own ADR.

## How this would scale further

- **`Transaction` table partitioning**: schema and indexes are designed so
  `PARTITION BY RANGE (createdAt)` can be introduced without a data
  migration once volume justifies it (see the note at the top of
  `prisma/schema.prisma`) — a reasonable threshold to revisit this is
  somewhere in the tens of millions of rows, or when sequential scans start
  showing up in `EXPLAIN ANALYZE` for date-bounded queries.
- **Kafka / multi-service split**: BullMQ is deliberately not Kafka — it's
  the right tool while there's one producer (the webhook endpoint) and one
  consumer group (the worker). If PayFlow ever splits into multiple
  independent services that all need to react to the same event stream
  (e.g. a separate billing-analytics service, a separate notifications
  service), that's the point to introduce a real event log.
- **Revenue stats rollups**: a tenant's stats are recomputed from scratch,
  which costs time proportional to that tenant's history. Past roughly
  100ms per recompute, the next step is per-period rollups — sum each
  closed month once, recompute only the open one — which keeps the
  recompute idempotent ([ADR-002](./docs/adr/002-eventual-consistency-analytics.md)).
- **Read replicas**: dashboard reads currently hit primary Postgres behind
  the Redis cache (ADR-002). If cached-dashboard traffic outgrows what
  caching alone absorbs, a read replica for `MaterializedRevenueStats`
  queries is the next lever, before reaching for anything more drastic.
