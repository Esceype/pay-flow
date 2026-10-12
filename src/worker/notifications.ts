import type Stripe from "stripe";
import { Prisma, type WebhookEvent } from "@prisma/client";
import { UnrecoverableError } from "bullmq";
import { EmailError, sendEmail } from "../lib/email";
import { log, withLogContext } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { subscriptionRefOfInvoice } from "../lib/subscription-state";

// Emails to tenants about what happened on their account (ADR-010). Runs on
// its own queue, after the event that caused it has been fully processed:
// sending an email is slow, talks to a third party, and must never be able
// to delay or fail the recording of a payment.

export interface NotificationDraft {
  kind: "payment_received" | "subscription_payment_failed";
  userId: string;
  recipient: string;
  subject: string;
  text: string;
}

const formatMoney = (cents: number, currency: string) =>
  `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;

// Decides what, if anything, a processed event is worth telling the tenant.
// Works from the database, not from the event alone: the question is never
// "did Stripe say paid" but "did we record a payment because of this event".
export async function buildNotification(
  webhookEvent: WebhookEvent
): Promise<NotificationDraft | null> {
  if (webhookEvent.type === "invoice.payment_failed") {
    return paymentFailed(webhookEvent);
  }
  return paymentReceived(webhookEvent);
}

// A payment event is only news if it produced a Transaction. Several Stripe
// events can mean "this was paid" (see checkout-session.ts) and only one of
// them records the payment — so only that one notifies, and the tenant gets
// one email per payment, not one per event.
async function paymentReceived(webhookEvent: WebhookEvent): Promise<NotificationDraft | null> {
  const transaction = await prisma.transaction.findFirst({
    where: { stripeEventId: webhookEvent.stripeEventId },
    include: {
      user: { select: { email: true } },
      invoice: { select: { customer: { select: { email: true } } } },
      subscription: { select: { customer: { select: { email: true } } } },
    },
  });
  if (!transaction) return null;

  const amount = formatMoney(transaction.amount, transaction.currency);
  const customer =
    transaction.invoice?.customer.email ?? transaction.subscription?.customer.email ?? "a customer";
  const source = transaction.subscription ? "a subscription payment" : "an invoice payment";

  return {
    kind: "payment_received",
    userId: transaction.userId,
    recipient: transaction.user.email,
    subject: `Payment received: ${amount} from ${customer}`,
    text: [
      `You received ${source} of ${amount} from ${customer}.`,
      "",
      "The funds are in your connected Stripe account; payouts follow your Stripe payout schedule.",
      "",
      "— PayFlow",
    ].join("\n"),
  };
}

// invoice.payment_failed changes nothing in our tables by itself (the
// subscription's PAST_DUE arrives as customer.subscription.updated), but it
// is the event that says *what* failed, so it is the one worth an email.
async function paymentFailed(webhookEvent: WebhookEvent): Promise<NotificationDraft | null> {
  const event = webhookEvent.payload as unknown as Stripe.InvoicePaymentFailedEvent;
  const invoice = event.data.object;

  const ref = subscriptionRefOfInvoice(invoice);
  if (!ref) return null;

  const subscription = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId: ref.stripeSubscriptionId },
    include: {
      user: { select: { email: true } },
      customer: { select: { email: true } },
    },
  });
  // Not one of ours, or (corrupt data) not this tenant's: nobody to tell.
  if (!subscription || subscription.userId !== webhookEvent.userId) return null;

  const amount = formatMoney(invoice.amount_due, invoice.currency);
  const nextAttempt = invoice.next_payment_attempt
    ? `Stripe will retry on ${new Date(invoice.next_payment_attempt * 1000).toISOString().slice(0, 10)}.`
    : "Stripe will not retry this payment automatically.";

  return {
    kind: "subscription_payment_failed",
    userId: subscription.userId,
    recipient: subscription.user.email,
    subject: `Payment failed: ${amount} from ${subscription.customer.email}`,
    text: [
      `A subscription payment of ${amount} from ${subscription.customer.email} failed` +
        (invoice.attempt_count ? ` (attempt ${invoice.attempt_count}).` : "."),
      "",
      nextAttempt,
      "You can see the subscription's current status on your PayFlow dashboard.",
      "",
      "— PayFlow",
    ].join("\n"),
  };
}

// The job. Two guards keep a tenant from getting the same email twice
// however often this runs for one event:
//
//   1. The Notification row, unique on kind + event id, is written before
//      sending and marked SENT after. A re-run finds it already SENT.
//   2. The same key is the provider's idempotency key, which covers the gap
//      guard 1 can't: a crash after the provider accepted the email but
//      before the row was marked. The retry sends again, with the same key,
//      and the provider answers with the first result instead of emailing.
export async function handleNotificationJob(webhookEventId: string): Promise<void> {
  const webhookEvent = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
  if (!webhookEvent) {
    throw new UnrecoverableError(`WebhookEvent ${webhookEventId} not found`);
  }

  await withLogContext(
    {
      webhookEventId,
      stripeEventId: webhookEvent.stripeEventId,
      eventType: webhookEvent.type,
      stripeAccountId: webhookEvent.stripeAccountId,
      userId: webhookEvent.userId,
    },
    async () => {
      const draft = await buildNotification(webhookEvent);
      if (!draft) return;

      const dedupeKey = `${draft.kind}:${webhookEvent.stripeEventId}`;
      const notification = await recordNotification(draft, dedupeKey);
      if (notification.status !== "PENDING") return;

      let result;
      try {
        result = await sendEmail(
          { to: notification.recipient, subject: notification.subject, text: draft.text },
          dedupeKey
        );
      } catch (err) {
        // A request the provider will never accept: don't burn the retries.
        if (err instanceof EmailError && err.permanent) {
          throw new UnrecoverableError(err.message);
        }
        throw err;
      }

      await prisma.notification.update({
        where: { id: notification.id },
        data:
          result.status === "sent"
            ? { status: "SENT", providerMessageId: result.id, sentAt: new Date() }
            : { status: "SKIPPED" },
      });
      log.info("notification handled", { kind: draft.kind, outcome: result.status });
    }
  );
}

// Insert-first, like every other "exactly once" row in this codebase: two
// jobs for the same event can't both pass an existence check.
async function recordNotification(draft: NotificationDraft, dedupeKey: string) {
  try {
    return await prisma.notification.create({
      data: {
        userId: draft.userId,
        kind: draft.kind,
        dedupeKey,
        recipient: draft.recipient,
        subject: draft.subject,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return prisma.notification.findUniqueOrThrow({ where: { dedupeKey } });
    }
    throw err;
  }
}
