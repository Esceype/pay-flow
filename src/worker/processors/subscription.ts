import type Stripe from "stripe";
import type { Subscription, WebhookEvent } from "@prisma/client";
import { UnrecoverableError } from "bullmq";
import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import {
  decideOrdering,
  isTerminal,
  snapshotFromStripe,
  subscriptionRefOfInvoice,
  SUBSCRIPTION_METADATA_KEY,
  TERMINAL_STATUSES,
  type SubscriptionSnapshot,
} from "../../lib/subscription-state";
import { claimWebhookEvent } from "../claim-webhook-event";

// Subscription lifecycle (ADR-007). Stripe is the source of truth for a
// subscription's state; our row mirrors it from customer.subscription.*
// events. BullMQ runs jobs concurrently and Stripe doesn't promise delivery
// order, so every write is guarded:
//
//   - terminal states absorb: once CANCELED / INCOMPLETE_EXPIRED, nothing
//     changes the row again, and a terminal event always applies
//   - otherwise an event applies only if its event.created is later than
//     the last applied one (Subscription.lastEventAt) — one conditional
//     UPDATE, so check and write are atomic
//   - an event from the same second as the last applied one can't be
//     ordered by timestamp, so the subscription is re-read from Stripe

type SubscriptionEvent =
  | Stripe.CustomerSubscriptionCreatedEvent
  | Stripe.CustomerSubscriptionUpdatedEvent
  | Stripe.CustomerSubscriptionDeletedEvent;

const notTerminal = { notIn: [...TERMINAL_STATUSES] };

// Finds our row for a Stripe subscription, linking it on first contact.
//
// A subscription only exists in Stripe once the customer completes
// Checkout, so until then our row has no stripeSubscriptionId. The row's id
// travels in the subscription's metadata instead, and whichever event is
// processed first (a lifecycle event or the first invoice.paid — their
// order isn't guaranteed) stores the Stripe id.
//
// Metadata is editable by the tenant in their own Stripe Dashboard, so the
// metadata path is scoped to that tenant's rows and to rows not linked yet:
// it can never re-point an existing link or reach another tenant's data.
async function resolveSubscription(
  webhookEvent: WebhookEvent,
  stripeSubscriptionId: string,
  payflowSubscriptionId: string | null
): Promise<Subscription | null> {
  const linked = await prisma.subscription.findUnique({ where: { stripeSubscriptionId } });
  if (linked) {
    // Stripe subscription ids are globally unique, so (as with Checkout
    // Sessions) a tenant mismatch here is corruption, not a race.
    if (linked.userId !== webhookEvent.userId) {
      throw new UnrecoverableError(
        `tenant mismatch: event from account ${webhookEvent.stripeAccountId} (user ${webhookEvent.userId}) ` +
          `for subscription ${linked.id} owned by user ${linked.userId}`
      );
    }
    return linked;
  }

  if (!payflowSubscriptionId || !webhookEvent.userId) return null;

  await prisma.subscription.updateMany({
    where: { id: payflowSubscriptionId, userId: webhookEvent.userId, stripeSubscriptionId: null },
    data: { stripeSubscriptionId },
  });
  // Re-read by Stripe id rather than trusting the count: if a concurrent
  // event linked the row first, this still finds it; if the metadata
  // pointed at nothing of this tenant's, it's null.
  return prisma.subscription.findUnique({ where: { stripeSubscriptionId } });
}

function requireSnapshot(subscription: Stripe.Subscription): SubscriptionSnapshot {
  const snapshot = snapshotFromStripe(subscription);
  if (!snapshot) {
    // A status this code doesn't know. Retrying can't teach it one, and
    // guessing would corrupt the mirror — surface it as FAILED instead.
    throw new UnrecoverableError(`unknown Stripe subscription status "${subscription.status}"`);
  }
  return snapshot;
}

export async function processSubscriptionEvent(webhookEvent: WebhookEvent): Promise<void> {
  const event = webhookEvent.payload as unknown as SubscriptionEvent;
  const stripeSubscription = event.data.object;

  const subscription = await resolveSubscription(
    webhookEvent,
    stripeSubscription.id,
    stripeSubscription.metadata?.[SUBSCRIPTION_METADATA_KEY] ?? null
  );
  if (!subscription) {
    // A subscription PayFlow didn't create (the tenant also uses their
    // Stripe account directly) — nothing of ours to update.
    console.warn(`[worker] ${event.type}: no Subscription for ${stripeSubscription.id} — no-op`);
    return;
  }

  const snapshot = requireSnapshot(stripeSubscription);
  const eventAt = new Date(event.created * 1000);

  if (isTerminal(snapshot.status)) {
    // Terminal event: applies no matter what was applied before or in what
    // order — it is the subscription's final state by definition.
    await prisma.subscription.updateMany({
      where: { id: subscription.id, status: notTerminal },
      data: { ...snapshot, lastEventAt: eventAt },
    });
    return;
  }

  // The ordering guard. The WHERE clause is decideOrdering()'s "apply" case.
  const applied = await prisma.subscription.updateMany({
    where: {
      id: subscription.id,
      status: notTerminal,
      OR: [{ lastEventAt: null }, { lastEventAt: { lt: eventAt } }],
    },
    data: { ...snapshot, lastEventAt: eventAt },
  });
  if (applied.count === 1) return;

  // Not applied — find out why.
  const current = await prisma.subscription.findUniqueOrThrow({
    where: { id: subscription.id },
    select: { status: true, lastEventAt: true },
  });
  const decision = decideOrdering(current, eventAt);

  if (decision === "tie") {
    await reconcileFromStripe(subscription, webhookEvent, eventAt);
    return;
  }
  if (decision === "apply") {
    // lastEventAt only ever moves forward, so a row that refused the UPDATE
    // can't have become eligible since. If it somehow did, let BullMQ retry
    // rather than silently dropping the event.
    throw new Error(`subscription ${subscription.id} changed while applying ${event.type}`);
  }
  console.log(
    `[worker] ${event.type}: discarded for subscription ${subscription.id} (${decision}; ` +
      `event ${eventAt.toISOString()}, last applied ${current.lastEventAt?.toISOString() ?? "none"})`
  );
}

// Tie-break for two events from the same second: ask Stripe what the
// subscription looks like now. A read, so no idempotency key; made on the
// tenant's connected account like every call on a tenant's behalf.
async function reconcileFromStripe(
  subscription: Subscription,
  webhookEvent: WebhookEvent,
  eventAt: Date
): Promise<void> {
  if (!subscription.stripeSubscriptionId || !webhookEvent.stripeAccountId) {
    throw new UnrecoverableError(`cannot reconcile subscription ${subscription.id}: missing Stripe ids`);
  }

  const fresh = await stripe.subscriptions.retrieve(
    subscription.stripeSubscriptionId,
    {},
    { stripeAccount: webhookEvent.stripeAccountId }
  );

  // Only while the row is still at the tied timestamp: if a newer event was
  // applied during the API call, that one is more recent than this read.
  await prisma.subscription.updateMany({
    where: { id: subscription.id, status: notTerminal, lastEventAt: eventAt },
    data: requireSnapshot(fresh),
  });
}

// invoice.paid for a subscription's billing period. Recorded as a
// Transaction against the Subscription — not as one of our Invoice rows,
// which are one-time, Checkout-backed records (ADR-006 / ADR-007).
//
// The subscription's *status* is not touched here: that arrives through
// customer.subscription.updated, which is also why invoice.payment_failed
// needs no processor — the resulting PAST_DUE comes the same way.
export async function processSubscriptionInvoicePaid(webhookEvent: WebhookEvent): Promise<void> {
  const event = webhookEvent.payload as unknown as Stripe.InvoicePaidEvent;
  const invoice = event.data.object;

  const ref = subscriptionRefOfInvoice(invoice);
  if (!ref) {
    console.log(`[worker] invoice.paid: ${invoice.id} is not a subscription invoice — no-op`);
    return;
  }

  const subscription = await resolveSubscription(
    webhookEvent,
    ref.stripeSubscriptionId,
    ref.payflowSubscriptionId
  );
  if (!subscription) {
    console.warn(`[worker] invoice.paid: no Subscription for ${ref.stripeSubscriptionId} — no-op`);
    return;
  }

  if (invoice.amount_paid <= 0) {
    // Trial period or fully discounted: paid, but no money moved.
    console.log(`[worker] invoice.paid: ${invoice.id} paid 0 — no Transaction`);
    return;
  }

  await prisma.$transaction(async (tx) => {
    // Nothing else makes this INSERT repeat-safe, so it commits together
    // with the event's PROCESSED marker — see claimWebhookEvent().
    if (!(await claimWebhookEvent(tx, webhookEvent.id))) return;

    await tx.transaction.create({
      data: {
        userId: subscription.userId,
        subscriptionId: subscription.id,
        stripeEventId: webhookEvent.stripeEventId,
        type: event.type,
        amount: invoice.amount_paid,
        currency: invoice.currency,
      },
    });
  });
}
