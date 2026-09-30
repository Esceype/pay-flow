import type Stripe from "stripe";
import type { WebhookEvent } from "@prisma/client";
import { prisma } from "../../lib/prisma";

export async function processCheckoutSessionCompleted(webhookEvent: WebhookEvent): Promise<void> {
  const event = webhookEvent.payload as unknown as Stripe.CheckoutSessionCompletedEvent;
  const session = event.data.object;

  const invoice = await prisma.invoice.findUnique({
    where: { stripeCheckoutSessionId: session.id },
    include: { customer: { select: { userId: true } } },
  });

  if (!invoice) {
    // Expected until Phase 3 creates real Checkout Sessions tied to an
    // Invoice via stripeCheckoutSessionId — every locally-triggered test
    // event (`stripe trigger checkout.session.completed`) hits this path.
    // Successfully processed, it just doesn't correspond to anything we
    // created — not an error.
    console.warn(
      `[worker] checkout.session.completed: no Invoice for session ${session.id} — no-op`
    );
    return;
  }

  if (invoice.status === "PAID") {
    // Already applied — e.g. this job was re-enqueued (ADR-001's jobId
    // dedup) after a crash between marking PROCESSED and returning.
    // Idempotent no-op rather than double-recording revenue.
    return;
  }

  await prisma.$transaction([
    prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: "PAID" },
    }),
    prisma.transaction.create({
      data: {
        // From our own Invoice -> Customer -> User chain, not from
        // webhookEvent.userId: that resolution can be null if the incoming
        // account wasn't recognized at receipt time, but if we found a
        // matching Invoice, our own data is the authoritative owner.
        userId: invoice.customer.userId,
        invoiceId: invoice.id,
        stripeEventId: webhookEvent.stripeEventId,
        type: event.type,
        amount: session.amount_total ?? invoice.amountDue,
        currency: session.currency ?? invoice.currency,
      },
    }),
  ]);
}
