import { Prisma, type Refund, type User } from "@prisma/client";
import { log } from "./logger";
import { paymentIntentForPayment } from "./payment-intents";
import { prisma } from "./prisma";
import { REFUND_METADATA_KEY, refundableAmount } from "./refund-state";
import { stripe } from "./stripe";

// Refunds requested from PayFlow (ADR-011). Same shape as every other
// outbound Stripe call here (ADR-006): our row first, then Stripe, keyed by
// that row's id. Unlike those, the refund's status is NOT written from
// Stripe's response — the worker writes it from the refund's events, as
// with subscriptions. The request only records which Stripe refund it got.

export class RefundError extends Error {}

type Tenant = Pick<User, "id"> & { stripeAccountId: string };

export async function requestRefund(
  input: { paymentId: string; amount: number; requestKey: string },
  tenant: Tenant
): Promise<Refund> {
  let refund: Refund;
  try {
    refund = await prisma.$transaction(async (tx) => {
      // The payment row is locked until this transaction ends. Reading what
      // is left to refund and recording the new refund have to happen as
      // one step: otherwise two requests at the same moment both see the
      // full amount available, and together refund more than was paid.
      const [payment] = await tx.$queryRaw<{ id: string; amount: number; currency: string }[]>`
        SELECT id, amount, currency FROM "Transaction"
        WHERE id = ${input.paymentId}
          AND "userId" = ${tenant.id}
          AND "refundId" IS NULL
          AND amount > 0
        FOR UPDATE`;
      if (!payment) throw new RefundError("not_refundable");

      const existing = await tx.refund.findMany({
        where: { paymentId: payment.id },
        select: { amount: true, status: true },
      });
      if (input.amount > refundableAmount(payment.amount, existing)) {
        throw new RefundError("exceeds_refundable");
      }

      return tx.refund.create({
        data: {
          userId: tenant.id,
          paymentId: payment.id,
          amount: input.amount,
          currency: payment.currency,
          requestKey: input.requestKey,
        },
      });
    });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    // Same requestKey: this form was already submitted (double-click, or a
    // retry after a slow response). Carry on with the refund it created.
    refund = await prisma.refund.findFirstOrThrow({
      where: { requestKey: input.requestKey, userId: tenant.id },
    });
  }

  await submitToStripe(refund, tenant);
  return prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
}

// For a refund whose request never got an answer from Stripe (timeout,
// Stripe down): ask again. Safe, because it is the same request under the
// same idempotency key — if the first one did reach Stripe, Stripe answers
// with the refund it already made instead of making a second one.
export async function retryRefund(refundId: string, tenant: Tenant): Promise<Refund> {
  const refund = await prisma.refund.findFirst({
    where: { id: refundId, userId: tenant.id },
  });
  if (!refund) throw new RefundError("not_found");
  if (refund.stripeRefundId || refund.status !== "PENDING" || !refund.requestKey) {
    throw new RefundError("not_retryable");
  }

  await submitToStripe(refund, tenant);
  return prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
}

// A 4xx from Stripe means the request itself is wrong and will stay wrong
// (the payment was disputed, or is already refunded, ...). 409 and 429 are
// the exceptions: a conflict on the idempotency key and rate limiting can
// both clear up on their own.
function isPermanentRejection(err: unknown): boolean {
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  return (
    typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 && ![409, 429].includes(statusCode)
  );
}

async function submitToStripe(refund: Refund, tenant: Tenant): Promise<void> {
  if (refund.stripeRefundId || refund.status !== "PENDING") return;

  const paymentIntentId = await paymentIntentForPayment(refund.paymentId, tenant.stripeAccountId);
  if (!paymentIntentId) {
    await markRejected(refund.id, "the payment's Stripe payment intent could not be found");
    throw new RefundError("no_payment_intent");
  }

  let stripeRefundId: string;
  try {
    const created = await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        amount: refund.amount,
        // The platform gives back its fee in proportion: refunding half the
        // payment returns half the application fee (ADR-011).
        refund_application_fee: true,
        metadata: { [REFUND_METADATA_KEY]: refund.id },
      },
      { stripeAccount: tenant.stripeAccountId, idempotencyKey: `refund-${refund.id}` }
    );
    stripeRefundId = created.id;
  } catch (err) {
    if (isPermanentRejection(err)) {
      await markRejected(refund.id, (err as Error).message);
      throw new RefundError("rejected");
    }
    // Unknown whether Stripe made the refund. The row stays PENDING and
    // unlinked: it still counts against the refundable amount (so nobody
    // can request the same money twice meanwhile), its refund.created event
    // links it if Stripe did make it, and retryRefund() can ask again.
    log.warn("refund request did not reach Stripe", { refundId: refund.id, err });
    throw new RefundError("unavailable");
  }

  // The worker may already have linked it from the refund.created event —
  // same id either way.
  await prisma.refund.updateMany({
    where: { id: refund.id, stripeRefundId: null },
    data: { stripeRefundId },
  });
}

// The one case where the request writes the status: Stripe refused to make
// the refund, so no refund exists and no event will ever arrive for it.
async function markRejected(refundId: string, reason: string): Promise<void> {
  await prisma.refund.updateMany({
    where: { id: refundId, status: "PENDING", stripeRefundId: null },
    data: { status: "FAILED", failureReason: `Rejected by Stripe: ${reason}`.slice(0, 500) },
  });
}
