import type { Prisma } from "@prisma/client";
import type { Job } from "bullmq";
import { prisma } from "../lib/prisma";
import { getRevenueStatsQueue, REVENUE_STATS_JOBS } from "../lib/queue";
import { invalidateRevenueStatsCache } from "../lib/revenue-stats";

// Write side of the revenue read model (ADR-002): the only code that
// changes MaterializedRevenueStats.
//
// A tenant's stats are always recomputed from scratch from Subscription and
// Transaction, never adjusted by a delta. A recompute is idempotent — run
// it once or five times, after a retry or a duplicate job, and the result
// is the same — whereas "+2900 for this payment" applied twice is simply
// wrong. The price is that each recompute reads all of the tenant's rows;
// ADR-002 covers when that stops being acceptable and what replaces it.

export const CHURN_WINDOW_DAYS = 30;

interface StatsRow {
  currency: string;
  mrr: number;
  activeSubscriptions: number;
  churnRate: number;
  totalRevenue: bigint;
}

// One recompute per tenant at a time, across every worker process: a
// transaction-scoped Postgres advisory lock, released when the transaction
// ends. Without it, two concurrent recomputes can finish in the opposite
// order to the one they read in, and the older snapshot overwrites the
// newer one. With it, whichever runs last also reads last — after
// everything committed before it — so the final rows always reflect every
// change that triggered a recompute.
export async function lockTenantStats(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"revenue-stats:" + userId}, 0))`;
}

export async function recomputeRevenueStats(userId: string, now: Date = new Date()): Promise<void> {
  const windowStart = new Date(now.getTime() - CHURN_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  await prisma.$transaction(
    async (tx) => {
      await lockTenantStats(tx, userId);

      // Subscriptions that never became real are left out entirely: rows
      // still awaiting checkout (no Stripe subscription) and ones whose
      // first payment never went through.
      //
      // mrr: ACTIVE and PAST_DUE, each normalized to one month.
      // churnRate: of the subscriptions already running when the window
      //   opened, the share canceled since.
      const rows = await tx.$queryRaw<StatsRow[]>`
        WITH subs AS (
          SELECT
            currency,
            COALESCE(ROUND(SUM(
              CASE WHEN status IN ('ACTIVE', 'PAST_DUE') THEN
                CASE "interval"
                  WHEN 'DAY'   THEN amount::numeric * 365 / 12
                  WHEN 'WEEK'  THEN amount::numeric * 52 / 12
                  WHEN 'MONTH' THEN amount::numeric
                  WHEN 'YEAR'  THEN amount::numeric / 12
                END / "intervalCount"
              ELSE 0 END
            )), 0)::int AS mrr,
            (COUNT(*) FILTER (WHERE status IN ('ACTIVE', 'PAST_DUE')))::int AS active,
            (COUNT(*) FILTER (
              WHERE "createdAt" < ${windowStart}::timestamp
                AND ("canceledAt" IS NULL OR "canceledAt" >= ${windowStart}::timestamp)
            ))::int AS running_at_window_start,
            (COUNT(*) FILTER (
              WHERE "createdAt" < ${windowStart}::timestamp
                AND status = 'CANCELED'
                AND "canceledAt" >= ${windowStart}::timestamp
            ))::int AS churned
          FROM "Subscription"
          WHERE "userId" = ${userId}
            AND "stripeSubscriptionId" IS NOT NULL
            AND status <> 'INCOMPLETE_EXPIRED'
          GROUP BY currency
        ),
        revenue AS (
          SELECT currency, SUM(amount)::bigint AS total
          FROM "Transaction"
          WHERE "userId" = ${userId}
          GROUP BY currency
        )
        SELECT
          COALESCE(subs.currency, revenue.currency) AS currency,
          COALESCE(subs.mrr, 0) AS mrr,
          COALESCE(subs.active, 0) AS "activeSubscriptions",
          CASE
            WHEN COALESCE(subs.running_at_window_start, 0) = 0 THEN 0
            ELSE subs.churned::float8 / subs.running_at_window_start
          END AS "churnRate",
          COALESCE(revenue.total, 0)::bigint AS "totalRevenue"
        FROM subs
        FULL OUTER JOIN revenue ON revenue.currency = subs.currency
      `;

      for (const row of rows) {
        const figures = {
          mrr: row.mrr,
          activeSubscriptions: row.activeSubscriptions,
          churnRate: row.churnRate,
          totalRevenue: row.totalRevenue,
          computedAt: now,
        };
        await tx.materializedRevenueStats.upsert({
          where: { userId_currency: { userId, currency: row.currency } },
          create: { userId, currency: row.currency, ...figures },
          update: figures,
        });
      }
      // A currency the tenant no longer has anything in.
      await tx.materializedRevenueStats.deleteMany({
        where: { userId, currency: { notIn: rows.map((row) => row.currency) } },
      });
    },
    // Waiting for another recompute of the same tenant counts against this.
    { timeout: 15_000, maxWait: 5_000 }
  );

  // After the commit, never before it: deleting first would let a reader
  // re-cache the old rows in the gap before the new ones are visible.
  await invalidateRevenueStatsCache(userId);
}

// Enqueues a recompute for every tenant. Run when the worker boots (so a
// deploy that changes the read model's shape repopulates it) and nightly:
// churn is measured over a sliding window, so it changes with the passage
// of time even when no event arrives. It also repairs any tenant whose
// recompute signal was lost.
export async function enqueueRecomputeForAllTenants(): Promise<number> {
  const BATCH = 500;
  let enqueued = 0;
  let cursor: string | undefined;

  for (;;) {
    const tenants = await prisma.user.findMany({
      // Connected tenants, plus anyone who has figures to keep current.
      where: { OR: [{ stripeAccountId: { not: null } }, { revenueStats: { some: {} } }] },
      select: { id: true },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
    if (tenants.length === 0) break;

    await getRevenueStatsQueue().addBulk(
      tenants.map((tenant) => ({
        name: REVENUE_STATS_JOBS.recompute,
        data: { userId: tenant.id },
      }))
    );
    enqueued += tenants.length;
    cursor = tenants[tenants.length - 1].id;
  }

  return enqueued;
}

export async function handleRevenueStatsJob(job: Job): Promise<void> {
  if (job.name === REVENUE_STATS_JOBS.refreshAll) {
    const enqueued = await enqueueRecomputeForAllTenants();
    console.log(`[worker] revenue stats: refresh enqueued for ${enqueued} tenant(s)`);
    return;
  }
  await recomputeRevenueStats((job.data as { userId: string }).userId);
}
