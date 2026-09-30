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
- Resend for transactional emails (sent via queue, not synchronously — not yet wired up)
- Vitest for unit tests (idempotency/ordering logic) + integration tests on
  the webhook endpoint (duplicate event delivery, concurrent lifecycle
  events) — not yet set up, scoped for Phase 5
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
  accounts). `stripeAccountId` and `onboardingComplete` on `User`.
- Two webhook endpoints, two separate secrets — see `.env.example` and
  `docs/adr/003-stripe-connect-multitenancy.md`:
  - Platform endpoint (`STRIPE_WEBHOOK_SECRET`): only `account.updated`,
    handled **synchronously**, no outbox/queue.
  - Connect endpoint (`STRIPE_CONNECT_WEBHOOK_SECRET`): all payment-relevant
    events from connected accounts, routed through the outbox + BullMQ
    pipeline.
- `WebhookEvent.stripeAccountId` is resolved to a `userId` BEFORE insert, so
  every downstream job knows which tenant it belongs to.
- Any Stripe API call the worker makes on behalf of a user MUST pass
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
   `WebhookEvent` `FAILED` via the Worker's `failed` listener.

Only `checkout.session.completed` has a real processor so far
(`processors/checkout-session-completed.ts`) — looks up an `Invoice` by
`stripeCheckoutSessionId`. Until Phase 3 creates real Checkout Sessions,
that lookup legitimately misses for every event (including
`stripe trigger checkout.session.completed`) — the processor logs and
no-ops rather than treating that as an error. Every other event type is
acknowledged (marked `PROCESSED`) without a registered processor — expected,
not a gap, until later phases add handlers for them.

## Ordering Guarantee (subscription lifecycle events)
BullMQ does not guarantee processing order across concurrent jobs. For a
given `stripeSubscriptionId`, compare the incoming Stripe `event.created`
against `Subscription.lastEventAt` before applying — discard stale
(out-of-order) events. Last-write-wins by event timestamp, not processing
time. (Field already exists on `Subscription`; the comparison logic itself
is Phase 2 work, not yet implemented.)

## Consistency Model
- STRONG consistency: `Invoice`/`Subscription` status updates — synchronous
  within the worker's transaction before marking the job complete.
- EVENTUAL consistency: analytics (MRR, churn) — separate read model
  (`MaterializedRevenueStats`, keyed per `userId`), updated asynchronously
  after each processed transaction.

## Idempotency (two layers — implement both)
1. Inbound: `WebhookEvent.stripeEventId` unique constraint.
2. Outbound: worker's own Stripe API calls use Stripe's idempotency-key
   parameter to protect against duplicate calls on worker retry.

## Caching Strategy
- Redis caches `MaterializedRevenueStats` per user with TTL (~30s) as a
  safety net, AND explicit cache invalidation (`DEL`) triggered by the
  worker on every new transaction affecting that user. Do not rely on TTL
  alone. (Not yet implemented — Phase 4.)

## Database Design Notes
- `Transaction`: schema/indexes anticipate future
  `PARTITION BY RANGE (createdAt)` without implementing it physically yet —
  see the comment block at the top of `prisma/schema.prisma`.
- Composite indexes: `(userId, createdAt)` on `Transaction`,
  `(customerId, status)` on `Invoice`, unique on `User.stripeAccountId` —
  each has an inline comment explaining why composite over separate
  single-column indexes.

## Rate Limiting / Backpressure
- Public API routes: token bucket rate limiting per user. (Not yet
  implemented — Phase 4.)
- Webhook endpoint is never rate-limited on receipt; worker concurrency is
  capped via BullMQ's `concurrency` option (`WORKER_CONCURRENCY` env var,
  default 5) to create backpressure instead of overwhelming the database.

## Testing Scope (minimal but explicit — do not skip when Phase 5 arrives)
- Unit tests: idempotency check logic, ordering/staleness check logic.
- Integration tests: webhook endpoint receiving a duplicate event (must not
  double-process), and two out-of-order subscription lifecycle events (must
  apply only the newer one).

## Build Order (confirm with me after each phase before proceeding)
0. ✅ Docker Compose infra + Prisma schema + BullMQ skeleton + Bull Board
1. ✅ Auth (Credentials + JWT) + Stripe Connect onboarding flow (OAuth,
   `account.updated` handling — sync, no outbox — UI gate on `onboardingComplete`).
   Real test-mode Stripe credentials are configured in `.env` (Connect
   client id, secret key, platform webhook secret) — Stripe CLI
   connectivity confirmed via `stripe trigger`.
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
3. Customer CRUD, invoice creation, Checkout integration (per connected account)
4. Subscriptions + lifecycle webhooks through the same pipeline (+ ordering guard, see above)
5. `MaterializedRevenueStats` read model + Redis caching + rate limiting
6. Dead-letter queue UI, graceful degradation if Redis is unavailable,
   structured logging with correlation IDs + `stripeAccountId`, test suite
7. ADR backfill (001 outbox pattern, 002 eventual consistency) + polished README

## Working style
I have 4 years of full-stack experience and am comfortable reviewing code,
but I'm using you to move faster and to correctly implement patterns I
understand conceptually but haven't fully implemented myself before. After
each phase, pause, summarize what was built, and explain any non-obvious
implementation decisions before I review and we proceed.
