import { UnrecoverableError } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { buildNotification, handleNotificationJob } from "@/worker/notifications";
import { recomputeRevenueStats } from "@/worker/revenue-stats";
import {
  createCustomer,
  createPayment,
  createTenant,
  holdRowLock,
  waitForLockWaiters,
} from "../db";
import { notificationsQueue, revenueStatsQueue } from "../queues";
import { storeEvent, stripeEvent, stripeRefund } from "../stripe-events";
import { processEvent } from "../worker";

// Refund events through the worker (ADR-011): linking them to our rows,
// moving the status forward only, and the ledger entries that follow. Plus
// what they feed: the revenue read model and the refund-failed email.

vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendEmail: vi.fn(),
}));
const send = vi.mocked(sendEmail);

beforeEach(() => {
  send.mockReset().mockResolvedValue({ status: "sent", id: "email_1" });
});

let sequence = 0;

// A tenant with a 20.00 payment, and a 5.00 refund of it requested from
// PayFlow that Stripe has accepted but whose events haven't been processed
// yet: our row is PENDING and not linked to the Stripe refund.
async function setUp() {
  const tenant = await createTenant();
  const customer = await createCustomer(tenant.id);
  const payment = await createPayment(customer, { amount: 2000, paymentIntent: "pi_test_1" });
  const refund = await prisma.refund.create({
    data: {
      userId: tenant.id,
      paymentId: payment.id,
      amount: 500,
      currency: "usd",
      requestKey: `request-${++sequence}`,
    },
  });
  const stripeRefundId = `re_flow_${sequence}`;
  const event = (
    type: "created" | "updated" | "failed",
    status: string,
    extra: { failureReason?: string } = {}
  ) =>
    stripeEvent(
      `refund.${type}`,
      stripeRefund({ id: stripeRefundId, status, payflowRefundId: refund.id, ...extra }),
      { account: tenant.stripeAccountId }
    );
  return { tenant, customer, payment, refund, stripeRefundId, event };
}

const reload = (id: string) => prisma.refund.findUniqueOrThrow({ where: { id } });
const ledgerOf = async (refundId: string) =>
  (await prisma.transaction.findMany({ where: { refundId }, orderBy: { amount: "asc" } })).map(
    (entry) => [entry.type, entry.amount]
  );

describe("refund events for a refund requested in PayFlow", () => {
  it("link it by metadata, and record the debit when it succeeds", async () => {
    const { payment, refund, stripeRefundId, event } = await setUp();

    await processEvent(event("created", "succeeded"));

    expect(await reload(refund.id)).toMatchObject({ stripeRefundId, status: "SUCCEEDED" });
    expect(await prisma.transaction.findMany({ where: { refundId: refund.id } })).toMatchObject([
      {
        type: "refund",
        amount: -500,
        currency: "usd",
        userId: payment.userId,
        // Under the same invoice as the payment it refunds.
        invoiceId: payment.invoiceId,
      },
    ]);
  });

  it("record nothing while the refund is pending", async () => {
    const { refund, event } = await setUp();

    await processEvent(event("created", "pending"));

    expect((await reload(refund.id)).status).toBe("PENDING");
    expect(await ledgerOf(refund.id)).toEqual([]);
  });

  it("don't let an older event undo a newer one", async () => {
    const { refund, event } = await setUp();

    // refund.updated (succeeded) processed before refund.created (pending).
    await processEvent(event("updated", "succeeded"));
    await processEvent(event("created", "pending"));

    expect((await reload(refund.id)).status).toBe("SUCCEEDED");
    expect(await ledgerOf(refund.id)).toEqual([["refund", -500]]);
  });

  it("debit once however many events report the success, even at the same moment", async () => {
    const { refund, event } = await setUp();

    await Promise.all([
      processEvent(event("created", "succeeded")),
      processEvent(event("updated", "succeeded")),
      processEvent(event("updated", "succeeded")),
    ]);

    expect(await ledgerOf(refund.id)).toEqual([["refund", -500]]);
  });

  it("reverse the debit when a refund fails after succeeding", async () => {
    const { refund, event } = await setUp();

    await processEvent(event("created", "succeeded"));
    await processEvent(event("failed", "failed", { failureReason: "lost_or_stolen_card" }));

    expect(await reload(refund.id)).toMatchObject({
      status: "FAILED",
      failureReason: "lost_or_stolen_card",
    });
    // Append-only: the debit stays, a credit cancels it.
    expect(await ledgerOf(refund.id)).toEqual([
      ["refund", -500],
      ["refund_reversal", 500],
    ]);
  });

  it("don't lose a failure processed at the same moment as the success before it", async () => {
    const { refund, event } = await setUp();
    await processEvent(event("created", "pending"));

    // "succeeded" queues on the row first, "failed" behind it: the failure
    // must be applied on top of the success, not judged against the
    // PENDING it would have read before the success committed.
    const release = await holdRowLock("Refund", refund.id);
    const succeeded = processEvent(event("updated", "succeeded"));
    await waitForLockWaiters(1);
    const failed = processEvent(event("failed", "failed"));
    await waitForLockWaiters(2);
    await release();
    await Promise.all([succeeded, failed]);

    expect((await reload(refund.id)).status).toBe("FAILED");
    expect(await ledgerOf(refund.id)).toEqual([
      ["refund", -500],
      ["refund_reversal", 500],
    ]);
  });

  it("record nothing for a refund that fails without having succeeded", async () => {
    const { refund, event } = await setUp();

    await processEvent(event("failed", "failed"));

    expect((await reload(refund.id)).status).toBe("FAILED");
    expect(await ledgerOf(refund.id)).toEqual([]);
  });

  it("don't revive a failed refund when a late 'succeeded' arrives", async () => {
    const { refund, event } = await setUp();

    await processEvent(event("failed", "failed"));
    await processEvent(event("updated", "succeeded"));

    expect((await reload(refund.id)).status).toBe("FAILED");
    expect(await ledgerOf(refund.id)).toEqual([]);
  });

  it("treat a canceled refund as final", async () => {
    const { refund, event } = await setUp();

    await processEvent(event("updated", "canceled"));
    await processEvent(event("updated", "succeeded"));

    expect((await reload(refund.id)).status).toBe("CANCELED");
    expect(await ledgerOf(refund.id)).toEqual([]);
  });

  it("ask for the tenant's stats to be recomputed, and for a notification check", async () => {
    const { tenant, event } = await setUp();

    const processed = await processEvent(event("created", "succeeded"));

    expect(revenueStatsQueue.add).toHaveBeenCalledExactlyOnceWith(
      "recompute",
      expect.objectContaining({ userId: tenant.id })
    );
    expect(notificationsQueue.add).toHaveBeenCalledExactlyOnceWith("refund.created", {
      webhookEventId: processed.id,
    });
  });

  it("fail without retrying on a refund status this code doesn't know", async () => {
    const { event } = await setUp();

    await expect(processEvent(event("updated", "some_future_status"))).rejects.toThrow(
      UnrecoverableError
    );
  });
});

describe("refunds made in the tenant's Stripe Dashboard", () => {
  const dashboardRefund = (account: string | null, paymentIntent: string, id?: string) =>
    stripeEvent(
      "refund.created",
      stripeRefund({
        id: id ?? `re_dash_${++sequence}`,
        status: "succeeded",
        amount: 700,
        paymentIntent,
      }),
      { account }
    );

  it("are mirrored onto the payment they refund, found by its payment intent", async () => {
    const { tenant, payment } = await setUp();
    const listInvoicePayments = vi.spyOn(stripe.invoicePayments, "list");

    await processEvent(dashboardRefund(tenant.stripeAccountId, "pi_test_1"));

    const [mirrored] = await prisma.refund.findMany({ where: { requestKey: null } });
    expect(mirrored).toMatchObject({ paymentId: payment.id, amount: 700, status: "SUCCEEDED" });
    expect(await ledgerOf(mirrored.id)).toEqual([["refund", -700]]);
    // The payment intent was already known: no Stripe call.
    expect(listInvoicePayments).not.toHaveBeenCalled();
  });

  it("are matched through Stripe when the payment's intent isn't known yet", async () => {
    const tenant = await createTenant();
    const customer = await createCustomer(tenant.id);
    const payment = await createPayment(customer, { via: "subscription", amount: 2900 });
    const list = vi
      .spyOn(stripe.invoicePayments, "list")
      .mockResolvedValue({ data: [{ invoice: payment.stripeInvoiceId }] } as never);

    await processEvent(dashboardRefund(tenant.stripeAccountId, "pi_unknown_yet"));

    expect(list).toHaveBeenCalledExactlyOnceWith(
      { payment: { type: "payment_intent", payment_intent: "pi_unknown_yet" }, limit: 1 },
      { stripeAccount: tenant.stripeAccountId }
    );
    expect(await prisma.refund.count({ where: { paymentId: payment.id } })).toBe(1);
    // Kept, so the next refund of this payment needs no lookup.
    const reloaded = await prisma.transaction.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reloaded.stripePaymentIntentId).toBe("pi_unknown_yet");
  });

  it("are matched through the Checkout Session for a one-time invoice", async () => {
    const tenant = await createTenant();
    const customer = await createCustomer(tenant.id);
    const payment = await createPayment(customer, { amount: 2000 });
    vi.spyOn(stripe.invoicePayments, "list").mockResolvedValue({ data: [] } as never);
    const listSessions = vi.spyOn(stripe.checkout.sessions, "list").mockResolvedValue({
      data: [{ id: payment.invoice!.stripeCheckoutSessionId }],
    } as never);

    await processEvent(dashboardRefund(tenant.stripeAccountId, "pi_from_checkout"));

    expect(listSessions).toHaveBeenCalledExactlyOnceWith(
      { payment_intent: "pi_from_checkout", limit: 1 },
      { stripeAccount: tenant.stripeAccountId }
    );
    expect(await prisma.refund.count({ where: { paymentId: payment.id } })).toBe(1);
  });

  it("are ignored when they refund something PayFlow didn't record", async () => {
    const tenant = await createTenant();
    vi.spyOn(stripe.invoicePayments, "list").mockResolvedValue({ data: [] } as never);
    vi.spyOn(stripe.checkout.sessions, "list").mockResolvedValue({ data: [] } as never);

    const processed = await processEvent(dashboardRefund(tenant.stripeAccountId, "pi_elsewhere"));

    expect(processed.status).toBe("PROCESSED");
    expect(await prisma.refund.count()).toBe(0);
  });

  it("are mirrored once when two events for the same refund arrive together", async () => {
    const { tenant } = await setUp();
    const object = stripeRefund({ id: "re_dash_twice", status: "succeeded", amount: 700 });
    const account = tenant.stripeAccountId;

    await Promise.all([
      processEvent(stripeEvent("refund.created", object, { account })),
      processEvent(stripeEvent("refund.updated", object, { account })),
    ]);

    const mirrored = await prisma.refund.findUniqueOrThrow({
      where: { stripeRefundId: "re_dash_twice" },
    });
    expect(await ledgerOf(mirrored.id)).toEqual([["refund", -700]]);
  });
});

describe("tenant isolation", () => {
  it("doesn't let another tenant's metadata claim a refund", async () => {
    const { refund } = await setUp();
    const otherTenant = await createTenant();
    vi.spyOn(stripe.invoicePayments, "list").mockResolvedValue({ data: [] } as never);
    vi.spyOn(stripe.checkout.sessions, "list").mockResolvedValue({ data: [] } as never);

    // Their own Stripe refund, carrying *this* tenant's row id.
    await processEvent(
      stripeEvent(
        "refund.created",
        stripeRefund({ id: "re_intruder", status: "succeeded", payflowRefundId: refund.id }),
        { account: otherTenant.stripeAccountId }
      )
    );

    expect(await reload(refund.id)).toMatchObject({ stripeRefundId: null, status: "PENDING" });
    expect(await prisma.transaction.count({ where: { refundId: { not: null } } })).toBe(0);
  });

  it("refuses an event for a linked refund from a tenant that doesn't own it", async () => {
    const { stripeRefundId, event } = await setUp();
    await processEvent(event("created", "pending"));
    const otherTenant = await createTenant();

    await expect(
      processEvent(
        stripeEvent("refund.updated", stripeRefund({ id: stripeRefundId, status: "succeeded" }), {
          account: otherTenant.stripeAccountId,
        })
      )
    ).rejects.toThrow(UnrecoverableError);
  });

  it("ignores refund events from an account that isn't a tenant", async () => {
    const processed = await processEvent(
      stripeEvent("refund.created", stripeRefund({ id: "re_stranger", status: "succeeded" }), {
        account: "acct_not_a_tenant",
      })
    );

    expect(processed.status).toBe("PROCESSED");
    expect(await prisma.refund.count()).toBe(0);
  });
});

describe("revenue after refunds", () => {
  const statsOf = (userId: string) => prisma.materializedRevenueStats.findMany({ where: { userId } });

  it("is net of refunds, with the refunds shown separately", async () => {
    const { tenant, event } = await setUp();
    await processEvent(event("created", "succeeded"));

    await recomputeRevenueStats(tenant.id);

    expect(await statsOf(tenant.id)).toMatchObject([
      { currency: "usd", totalRevenue: BigInt(1500), totalRefunds: BigInt(500) },
    ]);
  });

  it("goes back up when a refund fails after succeeding", async () => {
    const { tenant, event } = await setUp();
    await processEvent(event("created", "succeeded"));
    await processEvent(event("failed", "failed"));

    await recomputeRevenueStats(tenant.id);

    expect(await statsOf(tenant.id)).toMatchObject([
      { totalRevenue: BigInt(2000), totalRefunds: BigInt(0) },
    ]);
  });

  it("doesn't count a refund that is still pending", async () => {
    const { tenant, event } = await setUp();
    await processEvent(event("created", "pending"));

    await recomputeRevenueStats(tenant.id);

    expect(await statsOf(tenant.id)).toMatchObject([
      { totalRevenue: BigInt(2000), totalRefunds: BigInt(0) },
    ]);
  });
});

describe("the refund-failed email", () => {
  it("tells the tenant which refund failed, and why", async () => {
    const { tenant, customer, stripeRefundId, event } = await setUp();
    await processEvent(event("created", "succeeded"));
    const failed = await processEvent(
      event("failed", "failed", { failureReason: "expired_or_canceled_card" })
    );

    const draft = await buildNotification(failed);

    expect(draft).toMatchObject({
      kind: "refund_failed",
      dedupeKey: `refund_failed:${stripeRefundId}`,
      userId: tenant.id,
      recipient: tenant.email,
      subject: `Refund failed: 5.00 USD to ${customer.email}`,
    });
    expect(draft!.text).toContain("expired_or_canceled_card");
  });

  it("is sent once per refund, though two events report the failure", async () => {
    const { stripeRefundId, event } = await setUp();
    // Stripe sends both for one failure.
    const updated = await processEvent(event("updated", "failed"));
    const failed = await processEvent(event("failed", "failed"));

    await handleNotificationJob(updated.id);
    await handleNotificationJob(failed.id);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]).toBe(`refund_failed:${stripeRefundId}`);
    expect(await prisma.notification.findMany()).toMatchObject([
      { kind: "refund_failed", status: "SENT" },
    ]);
  });

  it("isn't sent for a refund that succeeded or is pending", async () => {
    const { event } = await setUp();
    const pending = await processEvent(event("created", "pending"));
    const succeeded = await processEvent(event("updated", "succeeded"));

    await handleNotificationJob(pending.id);
    await handleNotificationJob(succeeded.id);

    expect(send).not.toHaveBeenCalled();
  });

  it("isn't sent about one tenant's refund because of another tenant's event", async () => {
    const { stripeRefundId, event } = await setUp();
    await processEvent(event("failed", "failed"));
    const otherTenant = await createTenant();

    // An event from another account naming this tenant's failed refund
    // (the worker refuses to process it; the email must not go out either).
    const intruding = await storeEvent(
      stripeEvent("refund.failed", stripeRefund({ id: stripeRefundId, status: "failed" }), {
        account: otherTenant.stripeAccountId,
      })
    );

    expect(await buildNotification(intruding)).toBeNull();
  });
});
