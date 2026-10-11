# ADR-002: Revenue analytics as an asynchronously maintained, cached read model

## Context

The dashboard shows each tenant their MRR, active subscriptions, 30-day
churn and lifetime revenue. All of it can be derived from `Subscription`
and `Transaction`.

Deriving it on every page view means aggregating over a tenant's whole
history each time someone opens the dashboard. That cost grows with the
tenant, and it lands on the same tables the worker writes payments to.
Meanwhile nothing about these figures needs to be exact to the second: a
tenant does not care whether MRR reflects a payment 200ms or 3 seconds
after it happened.

Payment state is different. An invoice must never show `PAID` unless it is,
so invoice and subscription status are written by the worker in the same
transaction that processes the event (ADR-006, ADR-007). This ADR is about
the other half: the data that is allowed to lag.

## Decisions

### 1. A separate read model, one row per tenant per currency

`MaterializedRevenueStats` holds the finished figures. The dashboard reads
those rows by primary key and never aggregates anything itself. This is the
small version of CQRS: `Subscription` and `Transaction` are the write
model, this table is the read model, and it is *derived data* — every row
can be thrown away and rebuilt from the write model.

The key is `(userId, currency)`. A tenant can bill in several currencies,
and amounts in different currencies can't be added, so each currency gets
its own MRR and total instead of one meaningless sum.

### 2. Updated by the worker, after the fact, on its own queue

When the worker finishes an event that can change these figures (a payment
recorded, a subscription's status or price changed), it enqueues a
`recompute` job for that tenant on a second queue, `revenue-stats`. A
second BullMQ worker consumes it. A separate queue keeps analytics work
from ever sitting in front of payment events.

That signal is delivered **at least once**: it is sent after the event's
effects are committed, and if sending fails the job fails and BullMQ
retries it — including when the event itself was already marked processed.
A duplicate signal only recomputes the same figures twice.

So the figures are **eventually consistent**: normally seconds behind,
bounded by the lag of that queue. The dashboard says so, and shows
when the figures were computed.

### 3. Recompute from scratch; never apply a delta

| Option | Why not / why |
|---|---|
| **A — adjust by a delta** inside the event's transaction (`mrr += 2900`) | O(1) and strongly consistent, but not idempotent: a retried job adds twice unless every delta is separately de-duplicated. MRR deltas also need the *previous* state (a price change is `-old +new`). Churn is a ratio over a sliding window and has no delta at all. Any bug leaves the figures wrong forever, with nothing to correct them |
| **B — a Postgres materialized view** | `REFRESH` rebuilds every tenant at once. It can't be refreshed for one tenant after one event |
| **C — recompute one tenant's rows from the write model** | Chosen |

A recompute reads the tenant's subscriptions and transactions and replaces
the tenant's rows. Run it once or five times, after a retry or a duplicate
job, and the result is the same. A bug in the calculation is fixed for
everyone by fixing the query and letting the next refresh run. The price is
that each recompute costs time proportional to the tenant's data — see
Consequences.

### 4. One recompute per tenant at a time

Two recomputes of the same tenant running concurrently can finish in the
opposite order to the one they read in. The one that read older data then
overwrites the newer result, and the read model is stale until the next
event.

Each recompute therefore takes a transaction-scoped Postgres advisory lock
keyed by tenant before it reads. Whichever recompute runs last also reads
last, after everything committed before it. Since every change is followed
by a signal, the final rows reflect every change. An advisory lock was
chosen over running the queue with `concurrency: 1` because the latter only
holds with a single worker process, while the lock holds across all of
them.

### 5. A nightly refresh, and one at boot

Churn is measured over a sliding 30-day window, so it changes as time
passes even when no event arrives: a cancellation eventually falls out of
the window. Event-driven recomputes alone would leave it stale. A scheduled
job recomputes every tenant nightly.

The same job runs when the worker boots, which repopulates the table after
a deploy that changed its shape, and it repairs any tenant whose signal was
lost.

### 6. Cache: Redis in front of the read model, TTL plus explicit invalidation

Reads are cache-aside: Redis first, then the table, then the result is
cached. Two mechanisms keep it fresh, on purpose:

- **Explicit invalidation is the freshness mechanism.** After a recompute
  commits, the worker deletes the tenant's cache key. The next read sees
  the new figures immediately. The delete comes *after* the commit: deleting
  first would let a reader re-cache the old rows before the new ones are
  visible.
- **The TTL (30s) is the safety net.** It bounds how long a stale entry can
  survive the two cases invalidation can't cover: a delete that never
  reached Redis, and a reader that missed the cache, read the old rows, and
  wrote them back just after the worker's delete.

An empty result is cached as well. Tenants with no revenue yet are the ones
who would otherwise reach Postgres on every dashboard view.

The cache can only make a request faster. Every cache operation swallows
Redis errors and falls through to Postgres, and the cache's Redis
connection is configured to fail within a fraction of a second rather than
wait for Redis to come back.

Worth being honest about what the cache buys: the read model already turns
the dashboard query into a primary-key lookup. The cache's job is to keep
even that off the primary when many tenants are polling their dashboards.
At this project's scale that is a small win; the invalidation discipline is
the part that carries over to larger caches.

## Consequences

- **The figures lag.** Lists (invoices, subscriptions) and the revenue panel
  can briefly disagree. This is the designed trade-off, not a defect.
- **Recompute cost grows with the tenant.** MRR and churn scan the tenant's
  subscriptions; lifetime revenue sums the tenant's transactions through
  the `(userId, createdAt)` index. That is fine for thousands of rows per
  tenant. When it stops being fine (a recompute taking more than roughly
  100ms, or tenants with millions of transactions) the next step is
  per-period rollups: sum each closed month once, and recompute only the
  open one. That stays idempotent. It also fixes what partitioning
  `Transaction` by date would otherwise make worse — a lifetime sum that
  touches every partition.
- **A burst of events means a burst of recomputes.** They are serialized by
  the lock and each is correct, but most are redundant. Coalescing them per
  tenant is a possible optimization. It was deliberately not bolted on: a
  naive "skip if one is already queued" drops a signal that arrives while
  a recompute is already reading, which is exactly the lost update the
  current design rules out.
- **Definitions, stated so they can be argued with:** MRR counts `ACTIVE`
  and `PAST_DUE` subscriptions, each normalized to a month (yearly ÷ 12);
  trials and subscriptions that never started count for nothing. Churn is
  the share of subscriptions already running when the window opened that
  were canceled since. "Running when the window opened" uses the row's
  creation time, which slightly predates the customer completing checkout.
- **Lifetime revenue is gross.** Refunds and disputes aren't processed yet,
  so nothing subtracts from it.
- **One Redis instance for queue and cache.** BullMQ requires the
  `noeviction` policy, so the cache can't rely on LRU eviction. Every cache
  key carries a TTL instead.
