# ADR-008: Rate limiting with a token bucket in Redis

## Context

Three kinds of request can be made far more often than any legitimate use
needs, and each costs something real:

- **Tenant mutations** (create a customer, an invoice, a subscription;
  request a payment link; cancel). Each fans out into Stripe API calls on
  the tenant's connected account, and Stripe rate-limits that account. A
  script in a loop, or a buggy client, would spend the tenant's Stripe
  quota and fill the database with junk.
- **Login.** Every attempt runs a password comparison that is slow on
  purpose (scrypt). Unthrottled, that is both a password-guessing surface
  and a cheap way to keep a CPU busy.
- **Signup.** Same hashing cost, plus unlimited account creation.

One endpoint is deliberately excluded: the Stripe webhook. Refusing Stripe
would only cause retries and delay payments. Backpressure there comes from
the queue and the worker's bounded concurrency instead.

## Decisions

### Algorithm: token bucket

A bucket holds up to `capacity` tokens and regains `refillPerSecond` tokens
per second. A request takes one token; an empty bucket rejects.

| Option | Behaviour |
|---|---|
| Fixed window ("30 per minute") | Simple, but allows 60 in two seconds around a window boundary, and blocks a legitimate burst late in a window |
| Sliding window log | Exact, but stores one entry per request |
| **Token bucket** | Allows a short burst up to `capacity`, caps the sustained rate at the refill rate, and stores two numbers per subject. Chosen |

The burst matters here: someone working through the dashboard clicks
several things quickly and then stops. That should pass. A loop should not.

### State in Redis, updated atomically by a Lua script

The app can run as several instances, so the bucket can't live in process
memory. It lives in Redis (the cache database), one small hash per subject.

Refilling and taking a token is one Lua script. Doing it as
read-compute-write from the application would let concurrent requests all
read the same token count and all spend the same token. The script also
reads the time from Redis itself rather than from the caller: instances
that share a bucket must share a clock.

Each key expires after the time a bucket needs to refill completely. A
bucket left alone that long would be full again anyway, so idle subjects
cost no memory.

### What is limited, and by what

| Rule | Subject | Burst | Sustained |
|---|---|---|---|
| Tenant actions | signed-in tenant | 20 | 1 every 2s |
| Login | client address | 10 | 1 every 30s |
| Signup | client address | 5 | 1 per minute |

Tenant actions share one bucket across all mutations, checked in a single
place — `authorizeTenantAction()`, which every server action calls first —
and before the database is touched, so a throttled client doesn't cost a
query per rejected request.

A rejected form submission returns to its page with a message. A rejected
API call gets `429` with a `Retry-After` header.

### Failure mode: fail open

If Redis can't be reached, requests are allowed.

- **Fail closed** would turn a Redis outage into an outage of every form
  and every login in the app.
- **Fail open** means abuse protection is missing for as long as Redis is
  down.

The limiter guards against abuse; it is not what makes a request correct.
Losing it briefly is the smaller harm. To keep "open" from meaning "slow",
the Redis connection used here gives up within a fraction of a second
instead of queueing commands until Redis returns.

## Consequences

- **The client address comes from `X-Forwarded-For`** (left-most entry).
  That is only trustworthy behind a proxy that sets the header itself, such
  as Vercel or a load balancer. Reached directly, a client could send any
  value and get a fresh bucket each time; a deployment without such a proxy
  would have to use the socket address instead. With no header at all, as
  under plain `docker compose up`, every client shares one bucket.
- **Login is limited per address, not per account.** It slows one client
  guessing many passwords. It does not stop many addresses guessing at one
  account. Per-account lockout would, at the price of letting anyone lock a
  user out; it is not implemented.
- **The limits are constants in code**, not configuration. Changing one is
  a deploy.
- **Read-only pages aren't limited.** They only read PayFlow's own
  database (the revenue panel through the cache, ADR-002) and in normal
  operation call nothing external.
- This protects PayFlow and the tenant's Stripe quota from PayFlow's own
  users. It doesn't replace handling Stripe's own rate-limit responses.
