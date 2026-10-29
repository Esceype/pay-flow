import type Stripe from "stripe";
import { Prisma, type Refund, type RefundStatus, type WebhookEvent } from "@prisma/client";
import { UnrecoverableError } from "bullmq";
import { addLogContext, log } from "../../lib/logger";
import { paymentForPaymentIntent } from "../../lib/payment-intents";
import { prisma } from "../../lib/prisma";
import {
  canTransition,
  ledgerEffect,
  mapStripeRefundStatus,
  REFUND_METADATA_KEY,
} from "../../lib/refund-state";

// refund.created / refund.updated / refund.failed (ADR-011). Stripe is the
// source of truth for a refund's status; our row mirrors it, and the ledger
// follows the transitions.

type RefundEvent = Stripe.RefundCreatedEvent | Stripe.RefundUpdatedEvent | Stripe.RefundFailedEvent;

const idOf = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : (value?.id ?? null);

export async function processRefundEvent(webhookEvent: WebhookEvent): Promise<void> {
  const event = webhookEvent.payload as unknown as RefundEvent;
  const stripeRefund = event.data.object;

  const target = mapStripeRefundStatus(stripeRefund.status);
  if (!target) {
    throw new UnrecoverableError(`unknown Stripe refund status "${stripeRefund.status}"`);
  }
  if (!webhookEvent.userId || !webhookEvent.stripeAccountId) {
    log.info("refund event from an account that isn't a tenant");
    return;
  }

  const refund = await resolveRefund(webhookEvent, stripeRefund);
  if (!refund) {
    // A refund of a sale the tenant made outside PayFlow.
    log.info("refund event for a payment PayFlow did not record", { stripeRefundId: stripeRefund.id });
    return;
  }
  addLogContext({ refundId: refund.id });

  await applyStatus(refund, target, stripeRefund.failure_reason ?? null, webhookEvent);
}

// Finds our row for a Stripe refund, creating or linking it on first
// contact. Three ways in, most specific first:
//   1. already linked by Stripe refund id
//   2. requested from PayFlow: our row id is in the refund's metadata
//      (metadata is tenant-editable, so scoped to this tenant's unlinked rows)
//   3. made in the tenant's Stripe Dashboard: matched to one of our
//      payments by payment intent, and mirrored as a new row
async function resolveRefund(
  webhookEvent: WebhookEvent,
  stripeRefund: Stripe.Refund
): Promise<Refund | null> {
  const userId = webhookEvent.userId!;

  const linked = await prisma.refund.findUnique({ where: { stripeRefundId: stripeRefund.id } });
  if (linked) {
    // Stripe refund ids are globally unique: a mismatch is corruption.
    if (linked.userId !== userId) {
      throw new UnrecoverableError(
        `tenant mismatch: refund ${linked.id} belongs to user ${linked.userId}, event to user ${userId}`
      );
    }
    return linked;
  }

  const ourRefundId = stripeRefund.metadata?.[REFUND_METADATA_KEY];
  if (ourRefundId) {
    await prisma.refund.updateMany({
      where: { id: ourRefundId, userId, stripeRefundId: null },
      data: { stripeRefundId: stripeRefund.id },
    });
    const now = await prisma.refund.findUnique({ where: { stripeRefundId: stripeRefund.id } });
    if (now) return now;
  }

  const paymentIntentId = idOf(stripeRefund.payment_intent);
  if (!paymentIntentId) return null;
  const payment = await paymentForPaymentIntent(userId, paymentIntentId, webhookEvent.stripeAccountId!);
  if (!payment) return null;

  // Insert-first: the unique stripeRefundId decides between two events for
  // the same refund being processed at once.
  try {
    return await prisma.refund.create({
      data: {
        userId,
        paymentId: payment.id,
        stripeRefundId: stripeRefund.id,
        amount: stripeRefund.amount,
        currency: stripeRefund.currency,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return prisma.refund.findUnique({ where: { stripeRefundId: stripeRefund.id } });
    }
    throw err;
  }
}

// Moves the refund to `target` if that is a forward step from where it is,
// and writes the ledger entry the step calls for — in one transaction, so
// the entry is written exactly once: a duplicate event finds the row
// already moved and writes nothing.
//
// The row is locked before its status is read. The ledger entry depends on
// where the refund moves *from* (SUCCEEDED -> FAILED reverses a debit,
// PENDING -> FAILED moves no money), so the read and the write must see the
// same state: otherwise a "succeeded" committed in between turns a "failed"
// into a no-op, and the refund stays succeeded when it isn't.
async function applyStatus(
  refund: Refund,
  target: RefundStatus,
  failureReason: string | null,
  webhookEvent: WebhookEvent
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const [{ status: from }] = await tx.$queryRaw<{ status: RefundStatus }[]>`
      SELECT status FROM "Refund" WHERE id = ${refund.id} FOR UPDATE`;
    if (!canTransition(from, target)) {
      // A duplicate, or an older event processed after a newer one.
      // Ignoring it is correct: the states never cycle.
      log.info("refund event ignored: not a forward step", { from, to: target });
      return;
    }

    await tx.refund.update({
      where: { id: refund.id },
      data: { status: target, ...(target === "FAILED" && { failureReason }) },
    });

    const effect = ledgerEffect(from, target);
    if (effect) {
      const payment = await tx.transaction.findUniqueOrThrow({
        where: { id: refund.paymentId },
        select: { invoiceId: true, subscriptionId: true },
      });
      await tx.transaction.create({
        data: {
          userId: refund.userId,
          refundId: refund.id,
          // Same source as the payment, so "everything for this invoice /
          // subscription" includes its refunds.
          invoiceId: payment.invoiceId,
          subscriptionId: payment.subscriptionId,
          stripeEventId: webhookEvent.stripeEventId,
          type: effect === "debit" ? "refund" : "refund_reversal",
          amount: effect === "debit" ? -refund.amount : refund.amount,
          currency: refund.currency,
        },
      });
    }
    log.info("refund status changed", { from, to: target, ledger: effect });
  });
}
