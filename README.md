# PayFlow

Stripe Connect subscription & invoicing SaaS. Multi-tenant: each `User`
(tenant) connects their own Stripe account via Stripe Connect (Standard
accounts) — PayFlow itself never holds tenant funds.

Architecture rationale and phased build plan:
[`stripe-saas-senior-architecture-plan.md`](./stripe-saas-senior-architecture-plan.md).
Individual decisions are recorded in [`docs/adr/`](./docs/adr/) as they're made.

**Status: Phase 2 (webhook pipeline).** Phase 0 infra, Phase 1 auth +
Connect onboarding, and now the Connect webhook endpoint
(`/api/webhooks/stripe-connect`) — signature verification, idempotent
outbox insert + enqueue, worker dispatch, retry/backoff, dead-letter status
tracking — are all in place, with a real processor for
`checkout.session.completed`. No Customer/Invoice creation UI yet, so that
processor's Invoice lookup legitimately no-ops until Phase 3 — see
`docs/adr/001-outbox-pattern.md`.

## Architecture at a glance

```
Next.js app  ──┐
               ├──▶ PostgreSQL (Prisma)
               ├──▶ Redis db0 (BullMQ queue) / db1 (cache)
               └──▶ Stripe API (Connect, Checkout, Billing)

Worker (separate Node.js process)
  ├─ BullMQ Worker: consumes `webhook-events` queue
  └─ Express admin server (:3001)
       ├─ /healthz            — unauthenticated, for container healthchecks
       └─ /admin/queues       — Bull Board, HTTP Basic Auth required
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
- Bull Board: http://localhost:3001/admin/queues (Basic Auth: `BULL_BOARD_USER` / `BULL_BOARD_PASSWORD`)

Apply the Prisma schema against the containerized Postgres:

```bash
npx prisma migrate dev
```

(Reads `DATABASE_URL` from `.env`, which points at `localhost:5433` — see
"Port conflicts" below for why it isn't 5432.)

### Without Docker (app/worker on host, still need Postgres + Redis)

```bash
cp .env.example .env         # DATABASE_URL/REDIS_URL should point at localhost
npm install
npx prisma migrate dev
npm run dev                  # Next.js app
npm run worker:dev           # in a second terminal — BullMQ worker + Bull Board
```

## Using the app

1. Visit http://localhost:3000 — redirects to `/login`.
2. `/signup` to create a `User` (email + password, hashed with
   `crypto.scrypt` — see `docs/adr/004-auth-and-proxy-gate.md`), then log in.
3. `/dashboard` shows Connect status and a "Connect Stripe" button
   (`/api/connect/start`) if not yet connected.

There is **no `proxy.ts` auth gate** — each protected route/page checks the
session itself. See `docs/adr/004-auth-and-proxy-gate.md` for why (short
version: `next-auth@5` beta doesn't yet work with Next 16's `proxy.ts`
rename).

## Testing Stripe Connect locally

The OAuth round trip and `account.updated` webhook need a real Stripe
account in test mode — nothing here can be faked:

1. **Stripe Dashboard → Connect → Settings**: enable Standard accounts,
   copy the OAuth `client_id` into `STRIPE_CONNECT_CLIENT_ID`, and register
   `http://localhost:3000/api/connect/callback` as an OAuth redirect URI.
2. **Stripe Dashboard → Developers → API keys**: copy the test secret key
   into `STRIPE_SECRET_KEY`.
3. **Platform webhook** (`account.updated` only): either register
   `http://localhost:3000/api/webhooks/stripe-platform` as a normal webhook
   endpoint if using a tunnel (ngrok/Cloudflare Tunnel), or, simpler for
   local dev, use the Stripe CLI:
   ```bash
   stripe listen --events account.updated --forward-to localhost:3000/api/webhooks/stripe-platform
   ```
   The CLI prints a `whsec_...` value on startup — put that in
   `STRIPE_WEBHOOK_SECRET` (it's a different value than what the Dashboard
   would give you for a real endpoint, and changes every time you restart
   `stripe listen` unless you pass `--latest`).
4. Restart the `app` container (`docker compose up -d --build app`) so the
   new env vars take effect, then go through `/dashboard` → "Connect
   Stripe" with a real Stripe-hosted test account.

Without real Connect credentials, everything up to the redirect to Stripe's
consent screen still works (verified via `curl` against the placeholder
values in `.env.example`) — it's only the token exchange and the
`account.updated` webhook that need the real thing.

## Testing the Connect webhook pipeline (Phase 2) locally

The Connect endpoint (`/api/webhooks/stripe-connect`) is a **separate**
webhook endpoint from the platform one above, with its own secret
(`STRIPE_CONNECT_WEBHOOK_SECRET`) — don't reuse the platform endpoint's
`stripe listen` session for it, they need independent forwarding:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe-connect
```

Put the `whsec_...` this prints into `STRIPE_CONNECT_WEBHOOK_SECRET`
(different from `STRIPE_WEBHOOK_SECRET`'s value, even though both may
currently be the same placeholder if you haven't run this yet), restart the
`app` container, then:

```bash
stripe trigger checkout.session.completed
```

Expect it to reach the worker and no-op — `docker logs stripe-saas-worker-1`
should show `no Invoice for session ... — no-op`, and the corresponding
`WebhookEvent` row should end up `status = PROCESSED`. That's correct: no
UI creates an `Invoice` with a matching `stripeCheckoutSessionId` until
Phase 3, so there's nothing for `stripe trigger`'s synthetic session to
match against yet. The pipeline mechanics (signature check, idempotent
insert, outbox enqueue, worker pickup, retry/backoff) are what's actually
being exercised, not real business data.

If you don't have `stripe listen` running, you can still exercise the
endpoint directly with a validly-signed synthetic event using
`Stripe.webhooks.generateTestHeaderString()` against whatever's currently in
`STRIPE_CONNECT_WEBHOOK_SECRET` — this is how it was verified during
development, without needing a live tunnel.

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

See [`.env.example`](./.env.example) — every variable is documented inline,
including why `STRIPE_WEBHOOK_SECRET` (platform endpoint, `account.updated`
only, handled synchronously) and `STRIPE_CONNECT_WEBHOOK_SECRET` (Connect
endpoint, payment-relevant events, routed through the outbox + BullMQ
pipeline) are deliberately separate secrets — see
[`docs/adr/003-stripe-connect-multitenancy.md`](./docs/adr/003-stripe-connect-multitenancy.md).

`NEXTAUTH_SECRET` and `NEXTAUTH_URL` are required as of Phase 1 (session JWT
signing, and the base URL for the Connect `redirect_uri`) — `next dev` /
`docker compose up` will fail fast with a clear Zod error if either is
missing. Note that reading them happens lazily at request time, not at
module import — see
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
- **Read replicas**: dashboard reads currently hit primary Postgres (behind
  the Redis cache layer, see ADR-002 once written). If cached-dashboard
  traffic outgrows what caching alone absorbs, a read replica for
  `MaterializedRevenueStats` queries is the next lever, before reaching for
  anything more drastic.
