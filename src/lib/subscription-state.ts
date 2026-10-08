import type Stripe from "stripe";
import type { BillingInterval, SubscriptionStatus } from "@prisma/client";

// Pure subscription domain logic — no database, no Stripe client, no env —
// so the ordering and mapping rules can be unit-tested in isolation. The
// worker processors (src/worker/processors/subscription.ts) do the I/O.
// ADR-007.

// Set on the Stripe subscription (subscription_data.metadata at Checkout)
// and carried on every lifecycle event and subscription invoice, so the
// worker can find our row before stripeSubscriptionId has been stored.
export const SUBSCRIPTION_METADATA_KEY = "payflowSubscriptionId";

// Terminal in Stripe as well: a canceled or incomplete_expired subscription
// never becomes active again (a new subscription is created instead). Once
// a row is in one of these, no later-processed event may change it.
export const TERMINAL_STATUSES = [
  "CANCELED",
  "INCOMPLETE_EXPIRED",
] as const satisfies readonly SubscriptionStatus[];

export function isTerminal(status: SubscriptionStatus): boolean {
  return (TERMINAL_STATUSES as readonly SubscriptionStatus[]).includes(status);
}

const STATUS_BY_STRIPE_STATUS: Partial<Record<string, SubscriptionStatus>> = {
  incomplete: "INCOMPLETE",
  incomplete_expired: "INCOMPLETE_EXPIRED",
  trialing: "TRIALING",
  active: "ACTIVE",
  past_due: "PAST_DUE",
  unpaid: "UNPAID",
  paused: "PAUSED",
  canceled: "CANCELED",
};

const INTERVAL_BY_STRIPE_INTERVAL: Partial<Record<string, BillingInterval>> = {
  day: "DAY",
  week: "WEEK",
  month: "MONTH",
  year: "YEAR",
};

// Null for a status Stripe added after this was written — the caller
// decides how loudly to fail; guessing a status here would be worse.
export function mapStripeStatus(stripeStatus: string): SubscriptionStatus | null {
  return STATUS_BY_STRIPE_STATUS[stripeStatus] ?? null;
}

export interface SubscriptionSnapshot {
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  // Present only when the payload carries a recurring price; absent fields
  // leave the row's existing values untouched.
  amount?: number;
  currency?: string;
  interval?: BillingInterval;
  intervalCount?: number;
}

// Before API version 2025-03-31, current_period_end lived on the
// subscription itself; since then it's per subscription item. Webhook
// payloads are rendered in the platform account's API version, which this
// code doesn't control, so both shapes are read.
type LegacySubscriptionFields = { current_period_end?: number | null };

const toDate = (unixSeconds: number | null | undefined): Date | null =>
  typeof unixSeconds === "number" ? new Date(unixSeconds * 1000) : null;

// Everything we mirror from a Stripe subscription object, whether it came
// from an event payload or a fresh API read. Null if the status is unknown.
export function snapshotFromStripe(subscription: Stripe.Subscription): SubscriptionSnapshot | null {
  const status = mapStripeStatus(subscription.status);
  if (!status) return null;

  const items = subscription.items?.data ?? [];
  const firstItem = items[0];
  const periodEnd =
    firstItem?.current_period_end ?? (subscription as LegacySubscriptionFields).current_period_end;

  const snapshot: SubscriptionSnapshot = {
    status,
    currentPeriodEnd: toDate(periodEnd),
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    canceledAt: toDate(subscription.canceled_at),
  };

  const recurring = firstItem?.price?.recurring;
  const interval = recurring ? INTERVAL_BY_STRIPE_INTERVAL[recurring.interval] : undefined;
  if (firstItem && recurring && interval) {
    // PayFlow creates single-item subscriptions; summing keeps the amount
    // right if the tenant adds an item in their own Stripe Dashboard.
    snapshot.amount = items.reduce(
      (sum, item) => sum + (item.price?.unit_amount ?? 0) * (item.quantity ?? 1),
      0
    );
    snapshot.currency = firstItem.price.currency;
    snapshot.interval = interval;
    snapshot.intervalCount = recurring.interval_count;
  }

  return snapshot;
}

// What to do with a non-terminal lifecycle event, given the row's state:
//
//   apply    — event is newer than anything applied (or nothing was applied)
//   stale    — an event with a later timestamp was already applied: discard
//   tie      — same event.created second as the last applied event. Stripe
//              timestamps have one-second resolution and events carry no
//              sequence number, so the two can't be ordered from the events
//              themselves; the caller re-reads the subscription from Stripe
//   terminal — the row is CANCELED / INCOMPLETE_EXPIRED: nothing applies
//
// The worker's hot path doesn't call this — it does one conditional UPDATE
// whose WHERE clause is exactly the "apply" case, so the check and the
// write are atomic. This classifies the misses, and is the unit-tested
// statement of the rule that UPDATE implements.
export type OrderingDecision = "apply" | "stale" | "tie" | "terminal";

export function decideOrdering(
  current: { status: SubscriptionStatus; lastEventAt: Date | null },
  eventAt: Date
): OrderingDecision {
  if (isTerminal(current.status)) return "terminal";
  if (current.lastEventAt === null || current.lastEventAt < eventAt) return "apply";
  if (current.lastEventAt.getTime() === eventAt.getTime()) return "tie";
  return "stale";
}

export interface InvoiceSubscriptionRef {
  stripeSubscriptionId: string;
  // Our row id, from the subscription metadata Stripe snapshots onto the
  // invoice — lets an invoice.paid that is processed before any
  // customer.subscription.* event still find its row.
  payflowSubscriptionId: string | null;
}

// Same API-version story as above: the invoice -> subscription link moved
// from invoice.subscription to invoice.parent.subscription_details.
type LegacyInvoiceFields = {
  subscription?: string | { id: string } | null;
  subscription_details?: { metadata?: Record<string, string> | null } | null;
};

// Null for an invoice that doesn't belong to a subscription.
export function subscriptionRefOfInvoice(invoice: Stripe.Invoice): InvoiceSubscriptionRef | null {
  const legacy = invoice as LegacyInvoiceFields;
  const details = invoice.parent?.subscription_details ?? null;

  const subscription = details?.subscription ?? legacy.subscription ?? null;
  if (!subscription) return null;

  const metadata = details?.metadata ?? legacy.subscription_details?.metadata ?? null;
  return {
    stripeSubscriptionId: typeof subscription === "string" ? subscription : subscription.id,
    payflowSubscriptionId: metadata?.[SUBSCRIPTION_METADATA_KEY] ?? null,
  };
}
