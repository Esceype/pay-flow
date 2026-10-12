import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { getCacheRedis } from "@/lib/redis";
import {
  getRevenueStats,
  REVENUE_STATS_CACHE_TTL_SECONDS,
  revenueStatsCacheKey,
} from "@/lib/revenue-stats";
import { handleWebhookEvent } from "@/worker/handle-webhook-event";
import {
  enqueueRecomputeForAllTenants,
  lockTenantStats,
  recomputeRevenueStats,
} from "@/worker/revenue-stats";
import {
  createCustomer,
  createInvoice,
  createLinkedSubscription,
  createSubscription,
  createTenant,
  createTransaction,
} from "../db";
import { revenueStatsQueue } from "../queues";
import { getTestRedis, unreachableRedis } from "../redis";
import {
  checkoutSession,
  storeEvent,
  stripeEvent,
  stripeSubscription,
  subscriptionInvoice,
  T,
} from "../stripe-events";
import { processEvent } from "../worker";

async function setUpTenant() {
  const tenant = await createTenant();
  const customer = await createCustomer(tenant.id);
  return { tenant, customer };
}

const statsRows = (userId: string) =>
  prisma.materializedRevenueStats.findMany({ where: { userId }, orderBy: { currency: "asc" } });

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("recomputeRevenueStats", () => {
  it("computes MRR from running subscriptions, each normalized to a month", async () => {
    const { tenant, customer } = await setUpTenant();
    await createLinkedSubscription(customer, { amount: 2900, interval: "MONTH" }); // 2900
    await createLinkedSubscription(customer, { amount: 12000, interval: "YEAR" }); // 1000
    await createLinkedSubscription(customer, {
      status: "PAST_DUE", // still a subscription Stripe is trying to collect
      amount: 1000,
      interval: "MONTH",
      intervalCount: 3, // every three months: 333.33
    });
    // None of these is recurring revenue:
    await createLinkedSubscription(customer, { status: "CANCELED", amount: 5000 });
    await createLinkedSubscription(customer, { status: "TRIALING", amount: 700 });
    await createLinkedSubscription(customer, { status: "INCOMPLETE_EXPIRED", amount: 800 });
    await createSubscription(customer, { amount: 900 }); // never checked out

    await recomputeRevenueStats(tenant.id);

    expect(await statsRows(tenant.id)).toMatchObject([
      { currency: "usd", mrr: 4233, activeSubscriptions: 3 },
    ]);
  });

  it("sums lifetime revenue across invoice and subscription payments", async () => {
    const { tenant } = await setUpTenant();
    await createTransaction(tenant.id, { amount: 2000, type: "checkout.session.completed" });
    await createTransaction(tenant.id, { amount: 2900 });
    await createTransaction(tenant.id, { amount: 2900 });

    await recomputeRevenueStats(tenant.id);

    expect(await statsRows(tenant.id)).toMatchObject([
      { currency: "usd", totalRevenue: BigInt(7800), mrr: 0, activeSubscriptions: 0 },
    ]);
  });

  it("keeps each currency's figures apart", async () => {
    const { tenant, customer } = await setUpTenant();
    await createLinkedSubscription(customer, { amount: 2900, currency: "usd" });
    await createLinkedSubscription(customer, { amount: 1900, currency: "eur" });
    await createTransaction(tenant.id, { amount: 2900, currency: "usd" });
    await createTransaction(tenant.id, { amount: 500, currency: "gbp" }); // one-off payment only

    await recomputeRevenueStats(tenant.id);

    expect(await statsRows(tenant.id)).toMatchObject([
      { currency: "eur", mrr: 1900, totalRevenue: BigInt(0) },
      { currency: "gbp", mrr: 0, totalRevenue: BigInt(500) },
      { currency: "usd", mrr: 2900, totalRevenue: BigInt(2900) },
    ]);
  });

  it("measures churn among the subscriptions running when the 30-day window opened", async () => {
    const { tenant, customer } = await setUpTenant();
    const now = day("2026-06-30"); // window opens 2026-05-31
    const old = { createdAt: day("2026-01-01") };
    // Running when the window opened:
    await createLinkedSubscription(customer, { ...old });
    await createLinkedSubscription(customer, {
      ...old,
      status: "CANCELED",
      canceledAt: day("2026-06-10"), // churned inside the window
    });
    // Not part of the base:
    await createLinkedSubscription(customer, {
      ...old,
      status: "CANCELED",
      canceledAt: day("2026-04-01"), // already gone before the window
    });
    await createLinkedSubscription(customer, { createdAt: day("2026-06-15") }); // started inside it
    await createLinkedSubscription(customer, {
      createdAt: day("2026-06-15"),
      status: "CANCELED",
      canceledAt: day("2026-06-20"), // started and ended inside it
    });

    await recomputeRevenueStats(tenant.id, now);

    const [row] = await statsRows(tenant.id);
    expect(row.churnRate).toBe(0.5); // 1 churned of the 2 running at the start
    expect(row.computedAt).toEqual(now);
  });

  it("reports zero churn when nothing was running at the start of the window", async () => {
    const { tenant, customer } = await setUpTenant();
    await createLinkedSubscription(customer); // created just now

    await recomputeRevenueStats(tenant.id);

    expect((await statsRows(tenant.id))[0].churnRate).toBe(0);
  });

  it("gives the same result however many times it runs", async () => {
    const { tenant, customer } = await setUpTenant();
    await createLinkedSubscription(customer, { amount: 2900 });
    await createTransaction(tenant.id, { amount: 2900 });
    const now = day("2026-06-30");

    await recomputeRevenueStats(tenant.id, now);
    const first = await statsRows(tenant.id);
    await recomputeRevenueStats(tenant.id, now);
    await recomputeRevenueStats(tenant.id, now);

    expect(await statsRows(tenant.id)).toEqual(first);
    expect(first).toMatchObject([{ mrr: 2900, totalRevenue: BigInt(2900) }]);
  });

  it("drops a currency's row once nothing is left in that currency", async () => {
    const { tenant, customer } = await setUpTenant();
    await createLinkedSubscription(customer, { currency: "usd" });
    await prisma.materializedRevenueStats.create({
      data: { userId: tenant.id, currency: "eur", mrr: 1900, computedAt: new Date() },
    });

    await recomputeRevenueStats(tenant.id);

    expect((await statsRows(tenant.id)).map((row) => row.currency)).toEqual(["usd"]);
  });

  it("writes no rows for a tenant with nothing to report", async () => {
    const { tenant, customer } = await setUpTenant();
    await createSubscription(customer); // only one still awaiting checkout

    await recomputeRevenueStats(tenant.id);

    expect(await statsRows(tenant.id)).toEqual([]);
  });

  it("only ever counts the tenant's own data", async () => {
    const mine = await setUpTenant();
    const theirs = await setUpTenant();
    await createLinkedSubscription(mine.customer, { amount: 2900 });
    await createLinkedSubscription(theirs.customer, { amount: 9900 });
    await createTransaction(theirs.tenant.id, { amount: 9900 });

    await recomputeRevenueStats(mine.tenant.id);

    expect(await statsRows(mine.tenant.id)).toMatchObject([{ mrr: 2900, totalRevenue: BigInt(0) }]);
    expect(await statsRows(theirs.tenant.id)).toEqual([]);
  });

  it("waits for a recompute of the same tenant in progress, then reads what was committed meanwhile", async () => {
    const { tenant } = await setUpTenant();
    let waiting: Promise<void> | undefined;

    // Stand in for another recompute of this tenant that is mid-flight: hold
    // the tenant's lock, and let a payment commit before releasing it.
    await prisma.$transaction(async (tx) => {
      await lockTenantStats(tx, tenant.id);
      waiting = recomputeRevenueStats(tenant.id);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await createTransaction(tenant.id, { amount: 2900 });
    });
    await waiting;

    // Had it not waited, it would have read before the payment existed and
    // written a total of 0 — the stale overwrite the lock is there to stop.
    expect(await statsRows(tenant.id)).toMatchObject([{ totalRevenue: BigInt(2900) }]);
  });
});

describe("the recompute signal from the webhook pipeline", () => {
  it("is sent for the tenant after a payment is recorded", async () => {
    const { tenant, customer } = await setUpTenant();
    const invoice = await createInvoice(customer);

    await processEvent(
      stripeEvent(
        "checkout.session.completed",
        checkoutSession({ id: invoice.stripeCheckoutSessionId! }),
        { account: tenant.stripeAccountId }
      )
    );

    // causedBy carries the event id along, so the recompute's logs join
    // the event's.
    expect(revenueStatsQueue.add).toHaveBeenCalledExactlyOnceWith("recompute", {
      userId: tenant.id,
      causedBy: expect.stringMatching(/^evt_/),
    });
  });

  it("is sent after a subscription changes", async () => {
    const { tenant, customer } = await setUpTenant();
    const subscription = await createSubscription(customer);

    await processEvent(
      stripeEvent(
        "customer.subscription.created",
        stripeSubscription({
          id: "sub_test_signal",
          status: "active",
          payflowSubscriptionId: subscription.id,
        }),
        { account: tenant.stripeAccountId }
      )
    );

    expect(revenueStatsQueue.add).toHaveBeenCalledExactlyOnceWith(
      "recompute",
      expect.objectContaining({ userId: tenant.id })
    );
  });

  it("is not sent for events that can't change revenue", async () => {
    const { tenant, customer } = await setUpTenant();
    const invoice = await createInvoice(customer);
    const account = tenant.stripeAccountId;

    await processEvent(
      stripeEvent(
        "checkout.session.expired",
        checkoutSession({ id: invoice.stripeCheckoutSessionId!, paymentStatus: "unpaid" }),
        { account }
      )
    );
    await processEvent(stripeEvent("customer.created", { id: "cus_1" }, { account }));

    expect(revenueStatsQueue.add).not.toHaveBeenCalled();
  });

  it("is not sent for an event from an account that isn't a tenant", async () => {
    await processEvent(
      stripeEvent("invoice.paid", { id: "in_1", amount_paid: 100, parent: null }, {
        account: "acct_unknown",
      })
    );

    expect(revenueStatsQueue.add).not.toHaveBeenCalled();
  });

  it("is sent again when the job of an already-processed event runs again", async () => {
    const { tenant, customer } = await setUpTenant();
    const subscription = await createSubscription(customer);
    const stored = await storeEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoice({
          id: "in_test_signal",
          stripeSubscriptionId: "sub_test_signal",
          payflowSubscriptionId: subscription.id,
        }),
        { account: tenant.stripeAccountId, created: T }
      )
    );

    await handleWebhookEvent(stored.id);
    // The worker died after committing but before the signal went out, and
    // BullMQ runs the job again: the payment isn't recorded twice, but the
    // signal must still be delivered.
    await handleWebhookEvent(stored.id);

    expect(await prisma.transaction.count()).toBe(1);
    expect(revenueStatsQueue.add).toHaveBeenCalledTimes(2);
  });

  it("fails the job when the signal can't be enqueued, so BullMQ retries it", async () => {
    const { tenant, customer } = await setUpTenant();
    const invoice = await createInvoice(customer);
    const stored = await storeEvent(
      stripeEvent(
        "checkout.session.completed",
        checkoutSession({ id: invoice.stripeCheckoutSessionId! }),
        { account: tenant.stripeAccountId }
      )
    );
    revenueStatsQueue.add.mockRejectedValueOnce(new Error("Redis is down"));

    await expect(handleWebhookEvent(stored.id)).rejects.toThrow("Redis is down");
    await handleWebhookEvent(stored.id); // the retry

    expect(await prisma.transaction.count()).toBe(1);
    expect(revenueStatsQueue.add).toHaveBeenCalledTimes(2);
  });
});

describe("enqueueRecomputeForAllTenants", () => {
  it("enqueues one recompute per connected tenant", async () => {
    const first = await createTenant();
    const second = await createTenant();
    // Signed up, never connected Stripe, nothing to compute.
    await prisma.user.create({ data: { email: "not-a-tenant@example.test" } });

    const enqueued = await enqueueRecomputeForAllTenants();

    expect(enqueued).toBe(2);
    const jobs = revenueStatsQueue.addBulk.mock.calls.flatMap(([batch]) => batch);
    expect(jobs).toHaveLength(2);
    expect(jobs).toEqual(
      expect.arrayContaining([
        { name: "recompute", data: { userId: first.id } },
        { name: "recompute", data: { userId: second.id } },
      ])
    );
  });
});

describe("getRevenueStats (the cached read)", () => {
  async function setUpStats(mrr = 2900) {
    const context = await setUpTenant();
    await createLinkedSubscription(context.customer, { amount: mrr });
    await recomputeRevenueStats(context.tenant.id);
    return context;
  }

  it("returns the read model, per currency", async () => {
    const { tenant } = await setUpStats();
    await createTransaction(tenant.id, { amount: 2900 });
    await recomputeRevenueStats(tenant.id);

    const stats = await getRevenueStats(tenant.id);

    expect(stats.byCurrency).toEqual([
      { currency: "usd", mrr: 2900, activeSubscriptions: 1, churnRate: 0, totalRevenue: 2900 },
    ]);
    expect(stats.computedAt).toEqual(expect.any(String));
  });

  it("returns an empty result for a tenant with no revenue", async () => {
    const tenant = await createTenant();

    expect(await getRevenueStats(tenant.id)).toEqual({ byCurrency: [], computedAt: null });
  });

  it("serves repeat reads from Redis, with a TTL", async () => {
    const { tenant } = await setUpStats();

    const first = await getRevenueStats(tenant.id);
    // Change the table behind the cache's back: a cached read can't see it.
    await prisma.materializedRevenueStats.updateMany({
      where: { userId: tenant.id },
      data: { mrr: 1 },
    });
    const second = await getRevenueStats(tenant.id);

    expect(second).toEqual(first);
    const ttl = await getTestRedis().ttl(revenueStatsCacheKey(tenant.id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(REVENUE_STATS_CACHE_TTL_SECONDS);
  });

  it("shows new figures right after a recompute, without waiting for the TTL", async () => {
    const { tenant, customer } = await setUpStats(2900);
    expect((await getRevenueStats(tenant.id)).byCurrency[0].mrr).toBe(2900); // now cached

    await createLinkedSubscription(customer, { amount: 1000 });
    await recomputeRevenueStats(tenant.id); // commits, then deletes the cache entry

    expect((await getRevenueStats(tenant.id)).byCurrency[0].mrr).toBe(3900);
  });

  it("reads from Postgres when Redis is unavailable", async () => {
    const { tenant } = await setUpStats();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const down = unreachableRedis();
    vi.mocked(getCacheRedis).mockReturnValue(down);

    try {
      const stats = await getRevenueStats(tenant.id);
      expect(stats.byCurrency).toMatchObject([{ currency: "usd", mrr: 2900 }]);
      // The write side doesn't fail on it either: the figures are committed,
      // only the cache invalidation is skipped.
      await expect(recomputeRevenueStats(tenant.id)).resolves.toBeUndefined();
    } finally {
      down.disconnect();
    }
  });
});
