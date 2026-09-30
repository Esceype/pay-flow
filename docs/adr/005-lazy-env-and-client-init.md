# ADR-005: Env validation and shared clients (Prisma/Stripe/Redis) must be lazy

## Context

`src/lib/env.ts` originally called `envSchema.parse(process.env)` at module
top level, and `src/lib/prisma.ts` constructed `PrismaClient` at module top
level too. Both worked fine with `npm run build` on the host (Next.js
auto-loads `.env` from the working directory) but broke the Docker build:

```
Error: Failed to collect page data for /api/signup
...
ZodError: [DATABASE_URL, REDIS_URL, NEXTAUTH_SECRET, NEXTAUTH_URL: Required]
    at module evaluation (src/lib/env.ts:33)
    at <unknown> (src/lib/prisma.ts:3)
```

Root cause: `next build`'s "Collecting page data" step partially evaluates
route handler modules (imports execute, even though the actual request
handler isn't invoked) to determine route metadata. Inside the Docker
`builder` stage, `docker build` has no access to the runtime env vars
Docker Compose injects at container *start* — those only exist once the
container actually runs, not while the image is being built. Any module
that reads `process.env`/`env.X` at plain import time — not inside a
function called at request time — throws during that build step.

This is a environment/lifecycle mismatch, not a one-off bug: any module
that does real work (parse config, open a DB/Redis connection, construct an
SDK client) at import time is a landmine for this exact failure the moment
a route handler imports it, transitively or not.

## Decision

Nothing that reads `env.*` may run at plain module-import time. Concretely:

- **`env.ts`** exports a `Proxy` that defers `envSchema.parse(process.env)`
  until a property is actually read (`load()` inside the `get` trap), not
  at module evaluation.
- **`prisma.ts`** and **`stripe.ts`** export a `Proxy` wrapping a lazily
  constructed singleton (constructed on first property access, memoized
  after). Both SDKs expose delegate-style nested objects (`prisma.user`,
  `stripe.oauth`), which forward through the proxy trap cleanly; methods
  are explicitly `.bind()`ed so `this` isn't lost.
- **`redis.ts`** / **`queue.ts`** export plain **functions**
  (`getQueueRedis()`, `getWebhookEventsQueue()`), not Proxy-wrapped values.
  Unlike Prisma/Stripe, ioredis/BullMQ objects are handed to library
  internals that may do `instanceof` checks or otherwise depend on being
  the real object — faking that behind a Proxy is riskier than just
  changing the call site to `getX()`. This was free to choose because
  nothing consumed these two modules yet when the fix landed; the worker
  process (which is never subject to `next build`'s analysis — it runs via
  `tsx`, not through Next at all) calls the getters instead of importing
  bare instances.
- **`auth.ts`** passes `NextAuth(() => ({ ...config }))` — a **config
  factory function** — instead of a plain config object. Auth.js calls this
  per request rather than once at import time; a plain object literal would
  read `env.NEXTAUTH_SECRET` immediately on import, same failure mode.

Verified by building with the container's exact env-free conditions
(`env -i ... npx next build`, no `.env` present) and confirming it succeeds
before rebuilding the actual Docker image.

## Consequences

- Any new shared client (email SDK, future third-party API client) must
  follow the same lazy pattern — construct on first use, not at import.
  "Does this read `env.*` or open a connection at module scope?" is now a
  standing review question for anything added to `src/lib/`.
- The tradeoff of the Proxy approach (`prisma`, `stripe`) is a small
  indirection cost on every property access and slightly fuzzier
  TypeScript inference at the edges; accepted for keeping natural call-site
  ergonomics (`prisma.user.findUnique(...)` instead of
  `getPrisma().user.findUnique(...)` everywhere).
