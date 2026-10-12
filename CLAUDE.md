@AGENTS.md

# Project: PayFlow — Senior-Level Stripe Billing SaaS (multi-tenant, Stripe Connect)

## Context
Portfolio project demonstrating senior-level backend architecture for a
full-stack developer. This is a multi-tenant platform: each `User` connects
their own Stripe account via Stripe Connect (Standard accounts) — this is NOT
a single-Stripe-account CRUD wrapper. It should demonstrate data-intensive
systems thinking inspired by "Designing Data-Intensive Applications"
(Kleppmann): reliability under failure, eventual consistency where
appropriate, event-driven processing, correct multi-tenant data isolation,
and documented architectural trade-offs.

Full rationale: `stripe-saas-senior-architecture-plan.md`. Individual
decisions: `docs/adr/`.

## Tech Stack
- Next.js 16 (App Router, Turbopack), TypeScript, TailwindCSS
  - **Note:** this repo runs Next.js 16, not 14 as the original plan
    document assumed — `create-next-app@latest` installed it. Next 16 has
    breaking changes vs. older training data (see `AGENTS.md`, which is
    auto-managed by `next dev` — read `node_modules/next/dist/docs/` before
    touching anything App-Router-related). Notably: `middleware.ts` is
    deprecated in favor of `proxy.ts` (exported function `proxy`, not
    `middleware`; Node.js runtime only, no edge); `params`/`searchParams`
    are async in Route Handlers and pages.
- PostgreSQL + Prisma 7 ORM (schema partition-ready; see the note at the top
  of `prisma/schema.prisma`)
  - Prisma 7 removed `datasource.url` from `schema.prisma`. Connection
    config lives in `prisma.config.ts` (CLI) and `src/lib/prisma.ts`
    constructs `PrismaClient` with an explicit `@prisma/adapter-pg` driver
    adapter (runtime). Do not try to add `url = env("DATABASE_URL")` back
    into the datasource block — it will fail schema validation.
- Redis, one instance, two logical databases (`src/lib/redis.ts`): db 0 =
  BullMQ queues, db 1 = cache + rate limiter. The two connections are
  configured in opposite ways on purpose: the queue connection waits for
  Redis (`maxRetriesPerRequest: null`, BullMQ requires it); the cache
  connection fails within ~200ms, because nothing using it is essential to
  a request. Use `getCacheRedis()` only for things that may be skipped.
- BullMQ, separate worker process (`src/worker/`), three queues with one
  `Worker` each: `webhook-events` (Stripe events, ADR-001), `revenue-stats`
  (derived analytics, ADR-002) and `notifications` (emails, ADR-010). The
  worker process also runs the outbox relay on a plain timer.
- Operator pages served by the worker on its own port (`WORKER_HTTP_PORT`,
  default 3001), everything under `/admin` behind HTTP Basic Auth — the
  worker refuses to start without `BULL_BOARD_USER`/`BULL_BOARD_PASSWORD`:
  Bull Board at `/admin/queues` (jobs) and `/admin/events` (webhook events
  as rows: states, dead letters, replay — `src/worker/admin-events.ts`).
- Stripe Connect (Standard accounts) + Checkout + Billing/Subscriptions + Webhooks
- Auth.js (`next-auth@5`), Credentials provider (email+password), JWT
  sessions — see `docs/adr/004-auth-and-proxy-gate.md` for why this instead
  of OAuth/magic-link, and why there is **no `proxy.ts` auth gate** (removed
  after it broke every request in Docker — `next-auth@5` beta predates
  Next 16's `middleware`→`proxy` rename). Every protected route
  (`/dashboard`, `/api/connect/*`) checks `auth()` itself instead.
- Resend for emails to tenants, as a plain `fetch` (`src/lib/email.ts`),
  sent from the `notifications` queue, never from a request or from an
  event's own job (ADR-010). No API key (or the `re_...` placeholder) →
  notifications are recorded as `SKIPPED` and logged, nothing is sent.
- Structured logging: `src/lib/logger.ts` — JSON lines, with a context
  carried by `AsyncLocalStorage`. No `console.*` anywhere else in `src/`.
  See "Logging" below.
- Vitest 5 (`vitest.config.mts`, two projects): `npm test` = unit tests of
  pure logic next to the code (`src/**/*.test.ts`); `npm run
  test:integration` = webhook route + worker against a real Postgres and a
  real Redis (`test/integration/`; own `payflow_test` database created and
  migrated by `test/global-setup.ts`, Redis logical db 15). See "Testing"
  below. CI (`.github/workflows/ci.yml`) runs lint, typecheck, both test
  projects and an env-free `next build` on every push.
- Docker Compose: postgres, redis, nextjs app, worker — 4 independent
  services (`docker-compose.yml`, `docker/Dockerfile.app`, `docker/Dockerfile.worker`)
- Deploy (future): Vercel (app) + Railway or Render (worker + redis)

## Lazy env/client init — read before adding anything to `src/lib/`
`env.ts`, `prisma.ts`, `stripe.ts` all defer real work (env validation,
client construction) until first actual property access, via a `Proxy`.
`redis.ts`/`queue.ts` do the same via plain getter functions instead of a
Proxy. `auth.ts` passes a **config factory function** to `NextAuth()`, not a
plain object. This is not stylistic — `next build`'s page-data collection
step partially evaluates route handler modules with none of these env vars
set (Docker Compose injects them at container *start*, not at image *build*
time), so anything reading `env.*` at plain module-import time breaks the
Docker build. See `docs/adr/005-lazy-env-and-client-init.md`. Any new shared
client added to `src/lib/` must follow the same pattern.

## Multi-Tenancy Model (Stripe Connect — read this before touching the schema)
- Each `User` connects their own Stripe account via Connect OAuth (Standard
  accounts). `stripeAccountId`, `stripeConnectedAt` and `onboardingComplete`
  on `User`.
- **One webhook endpoint**, `/api/webhooks/stripe-connect`
  (`STRIPE_CONNECT_WEBHOOK_SECRET`), scoped to **Connected accounts**. Every
  event goes through the outbox + BullMQ pipeline — including
  `account.updated`, which for a connected account is a Connected-accounts
  event, NOT a platform one. An earlier design had a separate synchronous
  platform endpoint for it; that was wrong and was removed — see the
  amendment in `docs/adr/003-stripe-connect-multitenancy.md`. Local dev:
  `stripe listen --forward-connect-to <url>` (not `--forward-to`) and
  `stripe trigger --stripe-account acct_<id> <event>`.
- `account.application.deauthorized` unlinks the account — guarded by
  `User.stripeConnectedAt` so a stale queued deauthorization can't undo a
  reconnect.
- `WebhookEvent.stripeAccountId` is resolved to a `userId` BEFORE insert, so
  every downstream job knows which tenant it belongs to.
- Any Stripe API call made on behalf of a user (worker or request handler) MUST pass
  `{ stripeAccount: user.stripeAccountId }` — omitting this sends the
  request to the platform account instead of the tenant's account.
- Business actions (create Invoice, Checkout Session) are gated on
  `onboardingComplete = true`.

## Core Architectural Pattern: Transactional Outbox + Queue
✅ Implemented (`src/app/api/webhooks/stripe-connect/route.ts`,
`src/worker/index.ts`, `src/worker/processors/`, `src/worker/relay.ts`).
Actual flow — and read `docs/adr/001-outbox-pattern.md` (with its
amendment) before assuming step 3 is a literal cross-system
(Postgres+Redis) transaction, because it isn't:
1. Verify Stripe Connect webhook signature
2. Resolve `stripeAccountId` (`event.account`) → resolve owning `User`
3. Insert into `WebhookEvent`, unique on `stripeEventId` (idempotency guard
   — insert-first, catch `P2002` on duplicate, don't check-then-insert).
   **This insert is the commitment**: once the row exists the event is
   accepted. A database error here propagates as a 5xx (nothing durable →
   Stripe redelivers).
4. Enqueue a BullMQ job onto `webhook-events`
   (`getWebhookEventsQueue().add(...)`) with `jobId = webhookEvent.id` — this
   makes the *enqueue* idempotent independently of the DB insert. Best
   effort, bounded by `WEBHOOK_ENQUEUE_TIMEOUT_MS` (the queue's Redis
   connection would otherwise wait forever).
5. Return 200 OK to Stripe (before any business logic runs) — **also when
   the enqueue failed or timed out**. The earlier "non-200 so Stripe
   retries" behaviour is gone (ADR-001 amendment).
6. Worker (`src/worker/index.ts`) fetches the `WebhookEvent` row by id,
   dispatches to a per-type processor (`src/worker/processors/index.ts`),
   marks `PROCESSED`, then sends the follow-up signals (stats recompute,
   notification). A processor throwing BullMQ's `UnrecoverableError`
   (tenant mismatch, missing row) skips the remaining retries.
7. **Relay** (`src/worker/relay.ts`, a plain `setInterval` in the worker —
   deliberately not a BullMQ job): every minute, for events still
   `RECEIVED`/`PROCESSING` after 5 minutes — no job → enqueue one; job
   failed for good → mark the event `FAILED`; job in flight → leave it.

The job handler itself is `src/worker/handle-webhook-event.ts` (`index.ts`
only wires it into a BullMQ `Worker`) so tests can call it directly.

Dead letters (ADR-009, `src/worker/dead-letter.ts`): every failed attempt
writes `WebhookEvent.lastError`; the final one also sets `FAILED` +
`failedAt`; success clears both. Never mark a `PROCESSED` event failed (a
job can fail after its event was processed, when only a follow-up signal
couldn't be enqueued). Replay = conditional `FAILED → RECEIVED`, remove the
old failed job, enqueue — safe because every processor is idempotent, so
keep them that way.

Registered event types (`src/worker/processors/index.ts`). Each entry is
`{ process?, affectsRevenue?, notifies? }` — the two flags decide which
follow-up signals `handle-webhook-event.ts` sends after the event is done:
- `account.updated`, `account.application.deauthorized` (`account.ts`).
- The four Checkout events `checkout.session.completed` /
  `.async_payment_succeeded` / `.async_payment_failed` / `.expired`
  (`checkout-session.ts` — invoice state machine, conditional-UPDATE
  transitions, tenant check; ADR-006). Subscription-mode sessions are
  ignored there on purpose.
- `customer.subscription.created` / `.updated` / `.deleted` and
  `invoice.paid` (`subscription.ts`; ADR-007).
- `invoice.payment_failed`: `{ notifies: true }` and no processor — it
  changes nothing in our tables (the resulting `past_due` arrives as
  `customer.subscription.updated`) but it is what the tenant is emailed
  about.

An event for an object PayFlow didn't create (a `stripe trigger` session, a
subscription made in the tenant's own Stripe Dashboard) no-ops. Every other
event type is acknowledged (marked `PROCESSED`) without a processor —
expected, not a gap.

## Notifications (ADR-010)
- `src/worker/notifications.ts`, on the `notifications` queue. Whether to
  email is decided from the database, not the event: "payment received"
  only if a `Transaction` exists for that `stripeEventId` (one email per
  payment, not per "paid" event); "subscription payment failed" only for a
  subscription the event's tenant owns. Recipient is always the tenant.
- Sent at most once, two guards: a `Notification` row unique on
  `kind:stripeEventId` written before sending, and the same key as the
  provider's `Idempotency-Key`. Keep both when adding a notification kind.
- Provider 5xx/429 → job retries; permanent 4xx → `UnrecoverableError`.

## Logging
- `log.info|warn|error(msg, fields)` from `src/lib/logger.ts`. `msg` is a
  short stable string; variable data goes in `fields`; pass a caught error
  as `err`. Never `console.*`.
- Wrap each unit of work in `withLogContext({...})`; everything logged
  underneath carries those fields. `stripeEventId` is the correlation id:
  the webhook route, the event's job, the stats recompute it causes
  (`causedBy` in the job data) and its notification all log under it.
  `addLogContext()` adds a field once it becomes known (e.g. the tenant).

## Subscriptions (ADR-007 — read before touching `subscription.ts`)
- Created intent-first like invoices: row in `AWAITING_CHECKOUT`, Checkout
  Session in `mode: "subscription"`. Stripe creates the subscription only
  when the customer completes Checkout, so the row id travels in
  `subscription_data.metadata.payflowSubscriptionId`; the first event
  processed (lifecycle event OR `invoice.paid`, order not guaranteed) links
  `stripeSubscriptionId`. Metadata is tenant-editable → that lookup is
  scoped to the event's tenant and to unlinked rows only.
- **Ordering guard** (implemented): one conditional `UPDATE … WHERE status
  NOT IN (terminal) AND (lastEventAt IS NULL OR lastEventAt < event.created)`.
  Older event → discarded (still `PROCESSED`). Terminal states (`CANCELED`,
  `INCOMPLETE_EXPIRED`) absorb: a terminal event always applies, and nothing
  changes a terminal row. Same-second events can't be ordered by
  `event.created` (1s resolution) → **tie → re-read the subscription from
  Stripe**. The rule as a pure function: `decideOrdering()` in
  `src/lib/subscription-state.ts`.
- Subscription payments (`invoice.paid`) are `Transaction` rows with
  `subscriptionId` — NEVER our `Invoice` rows (those are one-time,
  Checkout-backed). No money moved (trial) → no Transaction.
- **One writer for status**: "Cancel" only calls Stripe; the row turns
  `CANCELED` when the worker processes `customer.subscription.deleted`.
  Don't write subscription status from request handlers.
- Invoice transitions don't need timestamps: each is a conditional
  `UPDATE ... WHERE status = 'PENDING'` (ADR-006).

## Consistency Model
- STRONG consistency: `Invoice`/`Subscription` status updates — synchronous
  within the worker's transaction before marking the job complete.
- EVENTUAL consistency: analytics (MRR, active subscriptions, 30-day churn,
  lifetime revenue) — separate read model `MaterializedRevenueStats`, one
  row per `(userId, currency)`. ADR-002. How it stays current:
  - `handle-webhook-event.ts` enqueues a `recompute` job on the
    `revenue-stats` queue after every event whose registry entry has
    `affectsRevenue: true` (at-least-once: also on a re-run of an
    already-`PROCESSED` event). A new processor that writes a `Transaction`
    or changes a subscription must set that flag.
  - `src/worker/revenue-stats.ts` is the ONLY writer of the table. It
    **recomputes the tenant's rows from scratch** in SQL — never apply
    deltas (not idempotent under retries) — inside a transaction holding a
    per-tenant Postgres advisory lock, so concurrent recomputes can't
    overwrite newer figures with older ones.
  - A nightly job (and one at worker boot) recomputes every tenant: churn
    is a sliding window, and this also repairs a lost signal.
  - Request handlers and pages never aggregate `Subscription`/`Transaction`
    for analytics; they call `getRevenueStats()` (`src/lib/revenue-stats.ts`).

## Idempotency (two layers — implement both)
1. Inbound: `WebhookEvent.stripeEventId` unique constraint.
2. Outbound: our own Stripe API calls use Stripe's idempotency-key
   parameter. Implemented for the request handlers as **intent-first**
   (`src/lib/billing.ts`, ADR-006): write our row first, call Stripe with a
   key derived from the row id, then store the Stripe id. Plus a per-render
   `requestKey` on the invoice and subscription forms against
   double-submits. Any Stripe write the worker makes must do the same.

Inside the worker, a processor's effect must also survive the job running
twice (crash after commit, before BullMQ acks). Two patterns in use:
- a conditional state transition that guards the insert (invoice
  `PENDING → PAID` + its `Transaction`), or
- `claimWebhookEvent(tx, id)` (`src/worker/claim-webhook-event.ts`): flip the
  `WebhookEvent` to `PROCESSED` in the same DB transaction as the effect,
  and skip the effect if it was already flipped (`invoice.paid`).
Not a unique constraint on `Transaction.stripeEventId` — partitioned tables
can't enforce uniqueness without the partition key (ADR-007).

## Caching Strategy
- Implemented (ADR-002): `getRevenueStats()` is cache-aside — Redis key
  `revenue-stats:<userId>`, then the read-model table, then cache the
  result (an empty result too). TTL 30s is the safety net; the freshness
  mechanism is the explicit `DEL` the stats worker issues **after** its
  recompute commits (deleting before the commit lets a reader re-cache old
  rows). Do not rely on TTL alone.
- `src/lib/cache.ts` wraps every cache operation so a Redis error becomes
  a miss / a no-op, never a failed request. Every cache key must have a
  TTL: the shared Redis runs `noeviction` for BullMQ's sake.

## Database Design Notes
- `Transaction`: schema/indexes anticipate future
  `PARTITION BY RANGE (createdAt)` without implementing it physically yet —
  see the comment block at the top of `prisma/schema.prisma`.
- Composite indexes: `(userId, createdAt)` on `Transaction` and `Invoice`
  (both carry a denormalized `userId`), `(customerId, status)` on `Invoice`,
  unique on `User.stripeAccountId` — each has an inline comment explaining
  why composite over separate single-column indexes.
- `Invoice.customer` / `Subscription.customer` are `onDelete: Restrict` —
  billing history is never deleted as a side effect of deleting a customer.
- Migrations that add NOT NULL columns are hand-edited to backfill existing
  rows (see `20260930120000_phase3_invoice_integrity`). `prisma migrate dev`
  refuses to run non-interactively here — use `prisma migrate diff` +
  `prisma migrate deploy`.

## Rate Limiting / Backpressure
- Implemented (ADR-008): token bucket in Redis, atomic via a Lua script
  that uses Redis' own clock (`src/lib/rate-limit.ts`). Rules: tenant
  mutations per user (burst 20, 1 per 2s), login and signup per client
  address. **Fails open** if Redis is unreachable.
- Every dashboard server action must start with `authorizeTenantAction()`
  (`src/lib/tenant.ts`): signed in → within rate limit → onboarded, in that
  order, and `redirectForTenantError(err, page)` in its catch block.
- Webhook endpoint is never rate-limited on receipt; worker concurrency is
  capped via BullMQ's `concurrency` option (`WORKER_CONCURRENCY` env var,
  default 5) to create backpressure instead of overwhelming the database.

## Testing (set up in Phase 4 — keep it current, don't defer)
- `npm test` — unit, no infra: `src/lib/billing.test.ts`,
  `src/lib/subscription-state.test.ts` (ordering rule, Stripe → our status
  mapping, both API payload shapes), `src/lib/rate-limit.test.ts`,
  `src/lib/logger.test.ts`, `src/lib/email.test.ts`,
  `checkout-session.test.ts`.
- `npm run test:integration` — needs `docker compose up -d postgres redis`.
  Real Postgres because the guarantees under test live in SQL (conditional
  UPDATEs, row locks, the advisory lock, the stats aggregation); real Redis
  because the rate limiter is a Lua script and the cache behaviour is the
  thing under test. What is faked, for every test, in
  `test/integration/setup.ts`: the three BullMQ queues (`test/queues.ts` —
  to observe enqueues, simulate Redis being down, and keep test jobs out of
  any real queue; `fakeJob()` stands in for a job's state), and
  `getCacheRedis()` is pointed at Redis logical db 15 (`test/redis.ts`).
  Stripe is never called; individual calls are spied. No email is sent: no
  API key is set, and `notifications.test.ts` replaces `sendEmail`.
  Covers: duplicate webhook delivery (must not double-process), enqueue
  failure → non-2xx → recovery, out-of-order / concurrent / same-second
  subscription events, late update after cancellation, `invoice.paid`
  before any lifecycle event, job re-run after commit, tenant isolation,
  the stats recompute (MRR normalization, per-currency, churn window,
  serialization on the tenant lock), the recompute signal, cache
  invalidation and Redis-down fallbacks, the token bucket, the endpoint
  with Redis down or hanging, the relay's four cases, failure recording
  and replay, the admin page (rendering, escaping, cross-site refusal),
  and notifications (what is sent, to whom, exactly once).
- Integration timeouts are raised (`testTimeout` 20s): the first test of a
  file also pays for opening the DB/Redis connections, and under load that
  alone passed the default 5s and failed unrelated tests.
- `scripts/send-test-event.mjs` sends a signed synthetic event to the
  running app — for exercising the pipeline by hand (dead letters, relay).
- `npm run test:all` runs both. Also `npm run typecheck`, `npm run lint`.
- The integration env is fixed in `vitest.config.mts` (never read from
  `.env`), and `test/global-setup.ts` refuses any database whose name
  doesn't end in `_test` — the tests TRUNCATE every table and FLUSHDB
  Redis db 15.
- A new processor or a new guarantee gets a test in the same change. When
  one is added, check the test fails with the guarantee removed.

## Build Order (confirm with me after each phase before proceeding)
0. ✅ Docker Compose infra + Prisma schema + BullMQ skeleton + Bull Board
1. ✅ Auth (Credentials + JWT) + Stripe Connect onboarding flow (OAuth,
   `account.updated` handling, UI gate on `onboardingComplete`). Real
   test-mode Stripe credentials are configured in `.env` (Connect client
   id, secret key). The original sync platform endpoint for
   `account.updated` was replaced in Phase 3 — see the ADR-003 amendment.
2. ✅ Webhook pipeline: signature verification → resolve tenant →
   idempotent insert → idempotent outbox enqueue (`jobId` dedup, ADR-001) →
   worker processes `checkout.session.completed` → retry/backoff (BullMQ,
   `src/lib/queue.ts`) → dead-letter at the data level (`WebhookEvent.status
   = FAILED` on exhausted retries; a dedicated UI beyond Bull Board's
   failed-jobs view is still Phase 6 scope). Verified live against the
   running containers with a properly HMAC-signed synthetic event
   (`stripe.webhooks.generateTestHeaderString`, since no Invoice exists yet
   to trigger a *real* `checkout.session.completed` through the app).
   **Scope note:** the "ordering guard" originally listed under this phase
   is a subscription-lifecycle concern (`customer.subscription.updated` vs
   `.deleted` racing) — moved to Phase 4, where the subscription processors
   that would actually need it get built. Building it now with nothing to
   call it would be speculative.
3. ✅ Customer CRUD + Checkout-backed invoices on the
   connected account (ADR-006): intent-first writes + Stripe idempotency
   keys, invoice state machine for all four Checkout events (async payment
   methods, expiry → "New payment link"), tenant check in the processor,
   platform fee (`PLATFORM_FEE_BPS`), currency allowlist, customers with
   invoices undeletable, public `/pay/*` pages. Also fixed: `account.updated`
   routing + `account.application.deauthorized` (ADR-003 amendment).
   Worker verified with HMAC-signed synthetic events (unpaid → async
   succeeded, 3 concurrent "paid" events → 1 Transaction, duplicate, expiry,
   tenant mismatch → FAILED without retries, stale vs fresh
   deauthorization, `account.updated` against the real test account).
   Then reviewed and verified end to end in the browser against the Stripe
   sandbox: hosted onboarding via Account Link (`/api/connect/onboarding`,
   with read-repair of `onboardingComplete` on the dashboard), customer →
   invoice → card payment → `PAID` + `Transaction` + platform fee, duplicate
   delivery via `stripe events resend`, session expiry → `EXPIRED` → "New
   payment link". Local gotcha that cost time: the Stripe CLI must be logged
   into the same account (sandbox) as `STRIPE_SECRET_KEY`, otherwise
   `stripe listen` forwards nothing — pass `--api-key` (see README).
4. ✅ Subscriptions through the same pipeline (ADR-007):
   `/dashboard/subscriptions` (create → Checkout link, cancel, discard
   pending), lifecycle processors with the ordering guard + tie-break +
   terminal states, `invoice.paid` → `Transaction` with the
   idempotent-consumer claim, platform fee via `application_fee_percent`.
   Test suite introduced here instead of Phase 6 (Vitest, 59 unit + 43
   integration tests; each guarantee checked by removing it and watching a
   test fail). Verified live against the Stripe sandbox with real events:
   Checkout link create/reuse/discard, a real subscription paid with a test
   card (`invoice.paid` deliberately delivered before
   `customer.subscription.created`), cancellation applied only via the
   webhook. Then reviewed and tested in the browser (subscribe through
   Checkout, cancel, discard). CI added right after (GitHub Actions).
5. ✅ Revenue read model, cache and rate limiting
   (ADR-002, ADR-008): `MaterializedRevenueStats` per `(userId, currency)`
   recomputed from scratch by a second BullMQ worker (`revenue-stats`
   queue) under a per-tenant advisory lock, triggered at-least-once after
   revenue-affecting events, plus a nightly/boot refresh; cache-aside read
   in Redis with TTL + explicit invalidation after commit; revenue panel on
   `/dashboard`; token-bucket rate limiting (Lua) for tenant mutations,
   login and signup, failing open. 137 tests (64 unit + 73 integration),
   each new guarantee checked by removing it. Verified live: boot refresh
   populated the read model to match the source tables; a real sandbox
   subscription moved MRR 10.00 → 39.00 and back to 10.00 on cancel with
   lifetime revenue staying put; cache key present with TTL; sixth signup
   from one address answered 429 with `Retry-After`.
6. ✅ (awaiting review) Reliability and operations: outbox relay + the
   endpoint acknowledging once the row is stored (ADR-001 amendment); dead
   letters with `lastError`, replay, and the `/admin/events` page;
   structured logs correlated by `stripeEventId` (ADR-009); email
   notifications on a third queue with two-layer de-duplication (ADR-010).
   213 tests (90 unit + 123 integration), 12 guarantees checked by removing
   them. Verified live: webhook during a real Redis outage → 200 in ~2.1s →
   app restarted so its pending enqueue was lost → relay delivered it; an
   unprocessable event → dead letter with its reason → replay → dead letter
   again; cross-site POST to the admin page → 403; real sandbox events →
   "payment received" and "subscription payment failed" notifications
   recorded as `SKIPPED` (no API key locally). Not verified: an email
   actually delivered by Resend.
7. Refunds and disputes (own phase, agreed 2026-10-12): `charge.refunded` /
   dispute events → negative `Transaction`s, invoice/subscription
   consequences, lifetime revenue becoming net, a notification.
8. Polished README + deploy (Vercel app, Railway/Render worker + Redis)

## Working style
I have 4 years of full-stack experience and am comfortable reviewing code,
but I'm using you to move faster and to correctly implement patterns I
understand conceptually but haven't fully implemented myself before. After
each phase, pause, summarize what was built, and explain any non-obvious
implementation decisions before I review and we proceed.
