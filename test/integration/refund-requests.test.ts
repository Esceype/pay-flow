import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { RefundError, requestRefund, retryRefund } from "@/lib/refunds";
import { stripe } from "@/lib/stripe";
import {
  createCustomer,
  createPayment,
  createTenant,
  holdRowLock,
  waitForLockWaiters,
} from "../db";

// Refunds requested from PayFlow: what is recorded, and what Stripe is
// asked. Stripe itself is replaced by spies — these tests are about our
// side of the call.

let createRefund: ReturnType<typeof vi.fn>;
beforeEach(() => {
  let n = 0;
  createRefund = vi
    .spyOn(stripe.refunds, "create")
    .mockImplementation(async () => ({ id: `re_test_${++n}`, status: "succeeded" }) as never) as never;
});

async function setUp(options: Parameters<typeof createPayment>[1] = {}) {
  const user = await createTenant();
  const customer = await createCustomer(user.id);
  const payment = await createPayment(customer, { paymentIntent: "pi_test_1", ...options });
  const tenant = { id: user.id, stripeAccountId: user.stripeAccountId! };
  const refund = (amount: number, requestKey = randomUUID()) =>
    requestRefund({ paymentId: payment.id, amount, requestKey }, tenant);
  return { tenant, customer, payment, refund };
}

const refundsOf = (paymentId: string) =>
  prisma.refund.findMany({ where: { paymentId }, orderBy: { createdAt: "asc" } });

describe("requestRefund", () => {
  it("records the refund, then asks Stripe for it on the tenant's account", async () => {
    const { tenant, payment, refund } = await setUp();

    const recorded = await refund(500);

    expect(createRefund).toHaveBeenCalledExactlyOnceWith(
      {
        payment_intent: "pi_test_1",
        amount: 500,
        refund_application_fee: true,
        metadata: { payflowRefundId: recorded.id },
      },
      // Keyed by our row: retrying this exact request can't refund twice.
      { stripeAccount: tenant.stripeAccountId, idempotencyKey: `refund-${recorded.id}` }
    );
    expect(recorded).toMatchObject({
      paymentId: payment.id,
      userId: tenant.id,
      amount: 500,
      currency: "usd",
      stripeRefundId: "re_test_1",
    });
  });

  it("leaves the status to Stripe's events, whatever the response says", async () => {
    const { refund } = await setUp();

    // Stripe answered "succeeded"; only the refund's events may say so here.
    const recorded = await refund(500);

    expect(recorded.status).toBe("PENDING");
    expect(await prisma.transaction.count({ where: { refundId: { not: null } } })).toBe(0);
  });

  it("allows partial refunds up to the amount paid, and no further", async () => {
    const { payment, refund } = await setUp({ amount: 2000 });

    await refund(500);
    await refund(1500);

    await expect(refund(1)).rejects.toThrow(new RefundError("exceeds_refundable"));
    expect((await refundsOf(payment.id)).map((r) => r.amount)).toEqual([500, 1500]);
  });

  it("refuses more than was paid without asking Stripe", async () => {
    const { payment, refund } = await setUp({ amount: 2000 });

    await expect(refund(2001)).rejects.toThrow(new RefundError("exceeds_refundable"));

    expect(createRefund).not.toHaveBeenCalled();
    expect(await refundsOf(payment.id)).toEqual([]);
  });

  it("refunds once when two full refunds are requested at the same moment", async () => {
    const { payment, refund } = await setUp({ amount: 2000 });

    // Both requests queue on the payment row behind a third transaction, so
    // they really do run at the same moment. Each reads "2000 left" unless
    // the row stays locked while one of them records its refund.
    const release = await holdRowLock("Transaction", payment.id);
    const settled = Promise.allSettled([refund(2000), refund(2000)]);
    await waitForLockWaiters(2);
    await release();
    const results = await settled;

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await refundsOf(payment.id)).toHaveLength(1);
    expect(createRefund).toHaveBeenCalledOnce();
  });

  it("refunds once when the same form is submitted twice", async () => {
    const { payment, refund } = await setUp();
    const requestKey = randomUUID();

    await refund(500, requestKey);
    await refund(500, requestKey);

    expect(await refundsOf(payment.id)).toHaveLength(1);
    expect(createRefund).toHaveBeenCalledOnce();
  });

  it("refuses another tenant's payment", async () => {
    const { payment } = await setUp();
    const otherUser = await createTenant();

    await expect(
      requestRefund(
        { paymentId: payment.id, amount: 500, requestKey: randomUUID() },
        { id: otherUser.id, stripeAccountId: otherUser.stripeAccountId! }
      )
    ).rejects.toThrow(new RefundError("not_refundable"));
    expect(createRefund).not.toHaveBeenCalled();
  });

  it("looks up an invoice payment's payment intent once, then keeps it", async () => {
    const { payment, refund } = await setUp({ paymentIntent: undefined });
    const retrieve = vi
      .spyOn(stripe.checkout.sessions, "retrieve")
      .mockResolvedValue({ id: "cs_x", payment_intent: "pi_from_session" } as never);

    await refund(500);
    await refund(500);

    expect(retrieve).toHaveBeenCalledExactlyOnceWith(
      payment.invoice!.stripeCheckoutSessionId,
      {},
      { stripeAccount: expect.any(String) }
    );
    expect(createRefund.mock.calls.map(([params]) => params.payment_intent)).toEqual([
      "pi_from_session",
      "pi_from_session",
    ]);
    const reloaded = await prisma.transaction.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reloaded.stripePaymentIntentId).toBe("pi_from_session");
  });

  it("finds a subscription payment's payment intent through its Stripe invoice", async () => {
    const { payment, refund } = await setUp({ via: "subscription", paymentIntent: undefined });
    const list = vi.spyOn(stripe.invoicePayments, "list").mockResolvedValue({
      data: [
        { status: "open", payment: { type: "payment_intent", payment_intent: "pi_abandoned" } },
        { status: "paid", payment: { type: "payment_intent", payment_intent: "pi_paid" } },
      ],
    } as never);

    await refund(500);

    expect(list).toHaveBeenCalledWith(
      { invoice: payment.stripeInvoiceId, limit: 10 },
      { stripeAccount: expect.any(String) }
    );
    expect(createRefund.mock.calls[0][0].payment_intent).toBe("pi_paid");
  });

  it("records a refund Stripe declines as failed, freeing the amount again", async () => {
    const { payment, refund } = await setUp({ amount: 2000 });
    createRefund.mockRejectedValueOnce(
      Object.assign(new Error("Charge ch_1 has been disputed"), { statusCode: 400 })
    );

    await expect(refund(2000)).rejects.toThrow(new RefundError("rejected"));

    expect(await refundsOf(payment.id)).toMatchObject([
      { status: "FAILED", failureReason: "Rejected by Stripe: Charge ch_1 has been disputed" },
    ]);
    // A rejected refund doesn't hold the money back from a later one.
    await expect(refund(2000)).resolves.toMatchObject({ amount: 2000 });
  });

  it("keeps a refund Stripe never answered as pending, and retries it under the same key", async () => {
    const { tenant, payment, refund } = await setUp({ amount: 2000 });
    createRefund.mockRejectedValueOnce(
      Object.assign(new Error("connect ETIMEDOUT"), { type: "StripeConnectionError" })
    );

    await expect(refund(2000)).rejects.toThrow(new RefundError("unavailable"));
    const [pending] = await refundsOf(payment.id);
    expect(pending).toMatchObject({ status: "PENDING", stripeRefundId: null });
    // Unknown whether Stripe made it, so it still counts as spent.
    await expect(refund(1)).rejects.toThrow(new RefundError("exceeds_refundable"));

    const retried = await retryRefund(pending.id, tenant);

    expect(retried.stripeRefundId).toBe("re_test_1");
    // The same idempotency key both times: had the first request reached
    // Stripe, the retry would get that refund back, not a second one.
    expect(createRefund.mock.calls.map(([, options]) => options.idempotencyKey)).toEqual([
      `refund-${pending.id}`,
      `refund-${pending.id}`,
    ]);
  });

  it("refuses to retry a refund Stripe already has", async () => {
    const { tenant, refund } = await setUp();
    const recorded = await refund(500);

    await expect(retryRefund(recorded.id, tenant)).rejects.toThrow(new RefundError("not_retryable"));
    expect(createRefund).toHaveBeenCalledOnce();
  });

  it("fails a refund whose payment intent can't be found", async () => {
    const { payment, refund } = await setUp({ via: "subscription", paymentIntent: undefined });
    vi.spyOn(stripe.invoicePayments, "list").mockResolvedValue({ data: [] } as never);

    await expect(refund(500)).rejects.toThrow(new RefundError("no_payment_intent"));
    expect(await refundsOf(payment.id)).toMatchObject([{ status: "FAILED" }]);
    expect(createRefund).not.toHaveBeenCalled();
  });
});
