import { prisma } from "./prisma";
import { cacheDelete, cacheGet, cacheSet } from "./cache";

// Read side of the revenue read model (ADR-002). The write side — the only
// code that changes MaterializedRevenueStats — is the worker's
// src/worker/revenue-stats.ts.

// Safety net, not the freshness mechanism: the worker deletes the cache
// entry whenever it recomputes a tenant's stats. The TTL bounds how long a
// stale entry can survive the cases explicit invalidation can't cover — a
// DEL that never reached Redis, or the read-then-set race described below.
export const REVENUE_STATS_CACHE_TTL_SECONDS = 30;

export interface CurrencyRevenueStats {
  currency: string;
  mrr: number; // cents per month
  activeSubscriptions: number;
  churnRate: number; // 0..1, last 30 days
  totalRevenue: number; // cents, lifetime, net of refunds
  totalRefunds: number; // cents, lifetime, positive
}

export interface RevenueStats {
  // One entry per currency the tenant has billed in; empty before the first
  // payment or subscription.
  byCurrency: CurrencyRevenueStats[];
  // ISO timestamp of the recompute these figures come from.
  computedAt: string | null;
}

export const revenueStatsCacheKey = (userId: string) => `revenue-stats:${userId}`;

// Cache-aside read: Redis first, then the read-model table — one primary-key
// range scan, never an aggregation over Subscription or Transaction.
//
// Known race, bounded by the TTL: a reader misses, reads the table, the
// worker then commits new stats and deletes the (still empty) key, and the
// reader writes the old figures back. They stay cached for at most
// REVENUE_STATS_CACHE_TTL_SECONDS — acceptable for figures that are
// eventually consistent by design.
export async function getRevenueStats(userId: string): Promise<RevenueStats> {
  const key = revenueStatsCacheKey(userId);

  const cached = await cacheGet<RevenueStats>(key);
  if (cached) return cached;

  const rows = await prisma.materializedRevenueStats.findMany({
    where: { userId },
    orderBy: { currency: "asc" },
  });
  const stats: RevenueStats = {
    byCurrency: rows.map((row) => ({
      currency: row.currency,
      mrr: row.mrr,
      activeSubscriptions: row.activeSubscriptions,
      churnRate: row.churnRate,
      // BigInt in the database; a JS number holds cents exactly up to about
      // 90 trillion in currency units, and JSON can't carry a bigint.
      totalRevenue: Number(row.totalRevenue),
      totalRefunds: Number(row.totalRefunds),
    })),
    // All of a tenant's rows are written by the same recompute.
    computedAt: rows[0]?.computedAt.toISOString() ?? null,
  };

  // An empty result is cached too: tenants with no revenue yet are exactly
  // the ones who would otherwise hit Postgres on every dashboard view.
  await cacheSet(key, stats, REVENUE_STATS_CACHE_TTL_SECONDS);
  return stats;
}

export function invalidateRevenueStatsCache(userId: string): Promise<boolean> {
  return cacheDelete(revenueStatsCacheKey(userId));
}
