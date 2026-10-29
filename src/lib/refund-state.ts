import type { RefundStatus } from "@prisma/client";

// Set on every refund PayFlow creates in Stripe, so the worker can tie the
// refund's events back to our row — the same role payflowSubscriptionId
// plays for subscriptions (ADR-007).
export const REFUND_METADATA_KEY = "payflowRefundId";

// Pure refund domain logic (ADR-011) — no database, no Stripe client.
//
// A refund's states form a graph with no cycles:
//
//     PENDING ──▶ SUCCEEDED ──▶ FAILED
//        │                        ▲
//        ├────────────────────────┘
//        └──▶ CANCELED
//
// Stripe never moves a refund backwards (a failed refund is not retried;
// a new refund is created instead). So applying an event means "move
// forward if this is a legal step from where the row is now, otherwise
// ignore it" — and that converges on Stripe's final state whatever order
// the events are processed in, with no timestamps. Compare subscriptions
// (ADR-007), whose states do cycle (active ↔ past_due) and therefore need
// event.created to order them.

// For each target state, the states it may be reached from.
const ALLOWED_FROM: Record<RefundStatus, readonly RefundStatus[]> = {
  PENDING: [],
  SUCCEEDED: ["PENDING"],
  FAILED: ["SUCCEEDED", "PENDING"],
  CANCELED: ["PENDING"],
};

export function canTransition(from: RefundStatus, to: RefundStatus): boolean {
  return ALLOWED_FROM[to].includes(from);
}

// What a transition does to the ledger:
//   debit   the refund went through: money left the tenant's account
//   credit  a refund that had gone through failed after all: the money
//           came back, so the debit is reversed by a new entry
//   null    no money moved (pending -> failed / canceled)
export function ledgerEffect(from: RefundStatus, to: RefundStatus): "debit" | "credit" | null {
  if (from === "PENDING" && to === "SUCCEEDED") return "debit";
  if (from === "SUCCEEDED" && to === "FAILED") return "credit";
  return null;
}

const STATUS_BY_STRIPE_STATUS: Partial<Record<string, RefundStatus>> = {
  pending: "PENDING",
  // Waiting on the customer (some payment methods need their bank details)
  // — not settled either way yet.
  requires_action: "PENDING",
  succeeded: "SUCCEEDED",
  failed: "FAILED",
  canceled: "CANCELED",
};

// Null for a status this code doesn't know, rather than a guess.
export function mapStripeRefundStatus(status: string | null): RefundStatus | null {
  return status ? (STATUS_BY_STRIPE_STATUS[status] ?? null) : null;
}

// How much of a payment can still be refunded. Pending refunds count as
// spent: they may yet succeed, and a refund requested on top of them could
// then exceed what was paid.
export function refundableAmount(
  paymentAmount: number,
  refunds: readonly { amount: number; status: RefundStatus }[]
): number {
  const committed = refunds
    .filter((refund) => refund.status === "PENDING" || refund.status === "SUCCEEDED")
    .reduce((sum, refund) => sum + refund.amount, 0);
  return Math.max(0, paymentAmount - committed);
}
