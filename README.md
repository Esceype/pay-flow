# PayFlow

Stripe Connect subscription & invoicing SaaS. Multi-tenant: each `User`
(tenant) connects their own Stripe account via Stripe Connect (Standard
accounts) — PayFlow itself never holds tenant funds.

Architecture rationale and phased build plan:
[`stripe-saas-senior-architecture-plan.md`](./stripe-saas-senior-architecture-plan.md).
Individual decisions are recorded in [`docs/adr/`](./docs/adr/) as they're made.

**Status: Phase 3 (customers + invoices) complete, awaiting review.**
Phase 0 infra, Phase 1 auth + Connect onboarding, Phase 2 webhook pipeline
(signature verification, idempotent outbox insert + enqueue, worker
dispatch, retry/backoff, dead-letter status tracking) and Phase 3 —
customers and invoices created on the tenant's connected account, paid via
one-time Checkout Sessions, with the payment outcome applied by the worker
from Stripe's webhooks (ADR-006). Next: Phase 4, subscriptions.

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
(`docker compose up -d app`) so it picks the value up.

For a deployed environment, create the endpoint in the Dashboard with
**Events from: Connected accounts** and enable at least the events the
worker handles (`src/worker/processors/index.ts`): `account.updated`,
`account.application.deauthorized`, `checkout.session.completed`,
`checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`.

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
4. Duplicate delivery: resend that event (Stripe Dashboard → the event →
   Resend, or `stripe events resend <evt_id> --stripe-account <acct_id>`)
   — the endpoint acks it, nothing is applied twice.

To fire a Connect-scoped test event without a real checkout:
`stripe trigger --stripe-account acct_... checkout.session.completed`. It
reaches the worker and no-ops (`no Invoice for session ...`) — that session
wasn't created by PayFlow.

Without the CLI, the endpoint can also be exercised with validly signed
synthetic events via `Stripe.webhooks.generateTestHeaderString()` against
`STRIPE_CONNECT_WEBHOOK_SECRET` — how the duplicate / concurrent /
out-of-order scenarios were verified during development.

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
- **Read replicas**: dashboard reads currently hit primary Postgres (behind
  the Redis cache layer, see ADR-002 once written). If cached-dashboard
  traffic outgrows what caching alone absorbs, a read replica for
  `MaterializedRevenueStats` queries is the next lever, before reaching for
  anything more drastic.
