import type Stripe from "stripe";
import type { InvoiceStatus, WebhookEvent } from "@prisma/client";
import { UnrecoverableError } from "bullmq";
import { log } from "../../lib/logger";
import { prisma } from "../../lib/prisma";

// Invoices are our own records backed by a one-time Checkout Session
// (ADR-006). Four Checkout events move an invoice out of PENDING:
//
//   checkout.session.completed
//     payment_status "paid" / "no_payment_required" -> PAID
//     payment_status "unpaid" -> stays PENDING: an async payment method
//       (SEPA, bank debit, ...) is still settling; one of the two events
//       below follows
//   checkout.session.async_payment_succeeded -> PAID
//   checkout.session.async_payment_failed    -> FAILED
//   checkout.session.expired                 -> EXPIRED
//
// Every transition is a conditional UPDATE ... WHERE status = 'PENDING'
// AND stripeCheckoutSessionId = <this session>, never read-then-write.
// That makes each one idempotent (a redelivered or re-enqueued event
// matches 0 rows) and safe under concurrency: if `completed` and
// `async_payment_succeeded` for the same session are processed at the same
// time, Postgres row-locks the invoice for the first UPDATE, and the
// second one re-evaluates its WHERE after that commits (READ COMMITTED)
// and matches nothing — so exactly one Transaction row is ever written.
// The session-id condition also means an event for a superseded session
// (the tenant regenerated the payment link) can't touch the invoice.

type CheckoutEvent =
  | Stripe.CheckoutSessionCompletedEvent
  | Stripe.CheckoutSessionAsyncPaymentSucceededEvent
  | Stripe.CheckoutSessionAsyncPaymentFailedEvent
  | Stripe.CheckoutSessionExpiredEvent;

type Outcome = Extract<InvoiceStatus, "PAID" | "FAILED" | "EXPIRED"> | "AWAITING_ASYNC_PAYMENT";

// Pure mapping from a Checkout event to what it means for the invoice —
// kept separate from the DB work so it can be unit-tested on its own.
export function checkoutOutcome(
  eventType: CheckoutEvent["type"],
  paymentStatus: Stripe.Checkout.Session.PaymentStatus
): Outcome {
  switch (eventType) {
    case "checkout.session.completed":
      return paymentStatus === "unpaid" ? "AWAITING_ASYNC_PAYMENT" : "PAID";
    case "checkout.session.async_payment_succeeded":
      return "PAID";
    case "checkout.session.async_payment_failed":
      return "FAILED";
    case "checkout.session.expired":
      return "EXPIRED";
  }
}

export async function processCheckoutSessionEvent(webhookEvent: WebhookEvent): Promise<void> {
  const event = webhookEvent.payload as unknown as CheckoutEvent;
  const session = event.data.object;

  if (session.mode === "subscription") {
    // A subscription's Checkout: its state comes from customer.subscription.*
    // and its payments from invoice.paid (processors/subscription.ts).
    // Invoices are only ever paid through mode "payment" sessions.
    return;
  }

  const invoice = await prisma.invoice.findUnique({
    where: { stripeCheckoutSessionId: session.id },
    select: { id: true, userId: true, amountDue: true, currency: true },
  });

  if (!invoice) {
    // A Checkout Session PayFlow didn't create (the tenant also uses their
    // Stripe account directly, or a `stripe trigger` test event) — nothing
    // of ours to update, and not an error.
    log.info("checkout event for a session PayFlow did not create", { sessionId: session.id });
    return;
  }

  // Tenant isolation check: the event must come from the connected account
  // of the tenant who owns this invoice. Checkout Session ids are globally
  // unique, so a mismatch means misconfiguration or corrupted data, not a
  // normal race — fail loudly (straight to FAILED, no retries: retrying
  // can't change who owns what) instead of crediting the wrong tenant.
  if (webhookEvent.userId !== invoice.userId) {
    throw new UnrecoverableError(
      `tenant mismatch: event from account ${webhookEvent.stripeAccountId} (user ${webhookEvent.userId}) ` +
        `for invoice ${invoice.id} owned by user ${invoice.userId}`
    );
  }

  const outcome = checkoutOutcome(event.type, session.payment_status);
  if (outcome === "AWAITING_ASYNC_PAYMENT") {
    log.info("invoice awaiting async payment, stays PENDING", { invoiceId: invoice.id });
    return;
  }

  const pendingForThisSession = {
    id: invoice.id,
    status: "PENDING" as const,
    stripeCheckoutSessionId: session.id,
  };

  if (outcome === "PAID") {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.invoice.updateMany({
        where: pendingForThisSession,
        data: { status: "PAID" },
      });
      // 0 rows: already PAID (duplicate/concurrent event) or no longer
      // PENDING for this session — the payment was already recorded.
      if (count === 0) return;

      await tx.transaction.create({
        data: {
          userId: invoice.userId,
          invoiceId: invoice.id,
          stripeEventId: webhookEvent.stripeEventId,
          type: event.type,
          amount: session.amount_total ?? invoice.amountDue,
          currency: session.currency ?? invoice.currency,
        },
      });
    });
    return;
  }

  // FAILED / EXPIRED: status only, no money moved.
  await prisma.invoice.updateMany({ where: pendingForThisSession, data: { status: outcome } });
}
