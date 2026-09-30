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
- Redis (BullMQ job queue on logical db 0 + cache on logical db 1, same
  instance — see `src/lib/redis.ts`)
- BullMQ for event-driven webhook processing (separate worker process,
  `src/worker/`)
- Bull Board for queue observability, served by the worker on its own port
  (`WORKER_HTTP_PORT`, default 3001) behind HTTP Basic Auth — the worker
  refuses to start without `BULL_BOARD_USER`/`BULL_BOARD_PASSWORD` set
- Stripe Connect (Standard accounts) + Checkout + Billing/Subscriptions + Webhooks
- Auth.js (`next-auth@5`), Credentials provider (email+password), JWT
  sessions — see `docs/adr/004-auth-and-proxy-gate.md` for why this instead
  of OAuth/magic-link, and why there is **no `proxy.ts` auth gate** (removed
  after it broke every request in Docker — `next-auth@5` beta predates
  Next 16's `middleware`→`proxy` rename). Every protected route
  (`/dashboard`, `/api/connect/*`) checks `auth()` itself instead.
- Resend for transactional emails (sent via queue, not synchronously — not
  yet wired up, Phase 6)
- Vitest for unit tests (idempotency/ordering logic) + integration tests on
  the webhook endpoint (duplicate event delivery, concurrent lifecycle
  events) — not yet set up, Phase 6
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
`src/worker/index.ts`, `src/worker/processors/`). Actual flow — and read
`docs/adr/001-outbox-pattern.md` before assuming step 3 is a literal
cross-system (Postgres+Redis) transaction, because it isn't:
1. Verify Stripe Connect webhook signature
2. Resolve `stripeAccountId` (`event.account`) → resolve owning `User`
3. Insert into `WebhookEvent`, unique on `stripeEventId` (idempotency guard
   — insert-first, catch `P2002` on duplicate, don't check-then-insert)
4. Enqueue a BullMQ job onto `webhook-events`
   (`getWebhookEventsQueue().add(...)`) with `jobId = webhookEvent.id` — this
   makes the *enqueue* idempotent independently of the DB insert
5. Return 200 OK to Stripe immediately (before any business logic runs); a
   failed enqueue returns non-200 on purpose, so Stripe's own retry becomes
   the recovery path for that gap (ADR-001)
6. Worker (`src/worker/index.ts`) fetches the `WebhookEvent` row by id,
   dispatches to a per-type processor (`src/worker/processors/index.ts`),
   marks `PROCESSED`. A job that exhausts all retries marks its
   `WebhookEvent` `FAILED` via the Worker's `failed` listener. A processor
   throwing BullMQ's `UnrecoverableError` (tenant mismatch, missing row)
   skips the remaining retries and is marked `FAILED` immediately.

Registered processors (`src/worker/processors/index.ts`): `account.updated`,
`account.application.deauthorized` (`account.ts`), and the four Checkout
events `checkout.session.completed` / `.async_payment_succeeded` /
`.async_payment_failed` / `.expired` (`checkout-session.ts` — invoice state
machine, conditional-UPDATE transitions, tenant check; see ADR-006). A
Checkout event for a session PayFlow didn't create (e.g. `stripe trigger`)
no-ops. Every other event type is acknowledged (marked `PROCESSED`) without
a processor — expected, not a gap, until later phases add handlers.

## Ordering Guarantee (subscription lifecycle events)
BullMQ does not guarantee processing order across concurrent jobs. For a
given `stripeSubscriptionId`, compare the incoming Stripe `event.created`
against `Subscription.lastEventAt` before applying — discard stale
(out-of-order) events. Last-write-wins by event timestamp, not processing
time. (Field already exists on `Subscription`; the comparison logic itself
is Phase 4 work — do it as a conditional SQL UPDATE, not read-compare-write
in JS.) Invoice transitions don't need timestamps: each is a conditional
`UPDATE ... WHERE status = 'PENDING'` (ADR-006).

## Consistency Model
- STRONG consistency: `Invoice`/`Subscription` status updates — synchronous
  within the worker's transaction before marking the job complete.
- EVENTUAL consistency: analytics (MRR, churn) — separate read model
  (`MaterializedRevenueStats`, keyed per `userId`), updated asynchronously
  after each processed transaction.

## Idempotency (two layers — implement both)
1. Inbound: `WebhookEvent.stripeEventId` unique constraint.
2. Outbound: our own Stripe API calls use Stripe's idempotency-key
   parameter. Implemented for the request handlers as **intent-first**
   (`src/lib/billing.ts`, ADR-006): write our row first, call Stripe with a
   key derived from the row id, then store the Stripe id. Plus a per-render
   `requestKey` on the invoice form against double-submits. Any Stripe call
   the worker makes in later phases must do the same.

## Caching Strategy
- Redis caches `MaterializedRevenueStats` per user with TTL (~30s) as a
  safety net, AND explicit cache invalidation (`DEL`) triggered by the
  worker on every new transaction affecting that user. Do not rely on TTL
  alone. (Not yet implemented — Phase 5.)

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
- Public API routes: token bucket rate limiting per user. (Not yet
  implemented — Phase 5.)
- Webhook endpoint is never rate-limited on receipt; worker concurrency is
  capped via BullMQ's `concurrency` option (`WORKER_CONCURRENCY` env var,
  default 5) to create backpressure instead of overwhelming the database.

## Testing Scope (minimal but explicit — do not skip when Phase 6 arrives)
- Unit tests: idempotency check logic, ordering/staleness check logic.
- Integration tests: webhook endpoint receiving a duplicate event (must not
  double-process), and two out-of-order subscription lifecycle events (must
  apply only the newer one).

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
3. ✅ (awaiting review) Customer CRUD + Checkout-backed invoices on the
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
   Real browser checkout not yet done: the connected test account
   (`phase3@example.com`) has `charges_enabled: false` pending
   `individual.id_number`.
4. Subscriptions + lifecycle webhooks through the same pipeline (+ ordering
   guard, see above). Decide first how Stripe's subscription invoices relate
   to our `Invoice` model (ADR-006, "Revisit before Phase 4").
5. `MaterializedRevenueStats` read model + Redis caching + rate limiting
6. Outbox relay for stuck `RECEIVED`/`PROCESSING` rows (closes ADR-001's
   gap), dead-letter queue UI with replay, graceful degradation if Redis is
   unavailable, structured logging with correlation IDs + `stripeAccountId`,
   Resend emails via the queue, test suite
7. ADR backfill (002 eventual consistency) + polished README + deploy

## Working style
I have 4 years of full-stack experience and am comfortable reviewing code,
but I'm using you to move faster and to correctly implement patterns I
understand conceptually but haven't fully implemented myself before. After
each phase, pause, summarize what was built, and explain any non-obvious
implementation decisions before I review and we proceed.
