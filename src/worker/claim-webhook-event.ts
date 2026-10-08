import type { Prisma } from "@prisma/client";

// Idempotent-consumer guard for processors whose effect is an INSERT with
// nothing else to make it safe to repeat (e.g. one Transaction per
// invoice.paid). Call it inside the same database transaction as the
// effect: it flips the WebhookEvent to PROCESSED and reports whether this
// call was the one that did. Effect and "processed" marker then commit or
// roll back together, so a job re-run after a crash — the classic window
// between "effect committed" and "job acknowledged" — claims nothing and
// writes nothing.
//
// This is used instead of a unique constraint on Transaction.stripeEventId
// because Transaction is designed to be range-partitioned by createdAt, and
// a partitioned table can't enforce uniqueness on a key that doesn't
// include the partition key. ADR-007.
export async function claimWebhookEvent(
  tx: Prisma.TransactionClient,
  webhookEventId: string
): Promise<boolean> {
  const { count } = await tx.webhookEvent.updateMany({
    where: { id: webhookEventId, status: { not: "PROCESSED" } },
    data: { status: "PROCESSED", processedAt: new Date() },
  });
  return count === 1;
}
