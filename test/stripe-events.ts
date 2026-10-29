import type { Prisma, WebhookEvent } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { SUBSCRIPTION_METADATA_KEY } from "@/lib/subscription-state";

// Builders for Stripe event payloads, shaped like the real ones (API
// version 2026-07-29) but carrying only the fields the code reads.

// An arbitrary fixed instant, in Stripe's unit (Unix seconds). Tests
// express event order as offsets from it: T, T + 5, ...
export const T = 1_800_000_000;
export const at = (unixSeconds: number) => new Date(unixSeconds * 1000);

export interface TestStripeEvent {
  id: string;
  object: "event";
  type: string;
  account: string | null;
  created: number;
  livemode: false;
  api_version: string;
  data: { object: Record<string, unknown> };
}

let sequence = 0;

export function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  options: { account: string | null; created?: number }
): TestStripeEvent {
  return {
    id: `evt_test_${++sequence}`,
    object: "event",
    type,
    account: options.account,
    created: options.created ?? T,
    livemode: false,
    api_version: "2026-07-29.dahlia",
    data: { object },
  };
}

// Stores an event the way the webhook route does (resolving the tenant from
// event.account), for tests that start at the worker.
export async function storeEvent(event: TestStripeEvent): Promise<WebhookEvent> {
  const owner = event.account
    ? await prisma.user.findUnique({ where: { stripeAccountId: event.account } })
    : null;
  return prisma.webhookEvent.create({
    data: {
      stripeEventId: event.id,
      stripeAccountId: event.account,
      userId: owner?.id,
      type: event.type,
      payload: event as unknown as Prisma.InputJsonValue,
    },
  });
}

export function checkoutSession(fields: {
  id: string;
  paymentStatus?: "paid" | "unpaid" | "no_payment_required";
  mode?: "payment" | "subscription";
  amountTotal?: number;
}) {
  return {
    id: fields.id,
    object: "checkout.session",
    mode: fields.mode ?? "payment",
    payment_status: fields.paymentStatus ?? "paid",
    amount_total: fields.amountTotal ?? 2000,
    currency: "usd",
  };
}

export function stripeSubscription(fields: {
  id: string;
  status: string;
  // Our row id, as Checkout puts it into the subscription's metadata.
  payflowSubscriptionId?: string;
  unitAmount?: number;
  interval?: "day" | "week" | "month" | "year";
  periodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: number | null;
}) {
  return {
    id: fields.id,
    object: "subscription",
    status: fields.status,
    cancel_at_period_end: fields.cancelAtPeriodEnd ?? false,
    canceled_at: fields.canceledAt ?? null,
    metadata: fields.payflowSubscriptionId
      ? { [SUBSCRIPTION_METADATA_KEY]: fields.payflowSubscriptionId }
      : {},
    items: {
      object: "list",
      data: [
        {
          object: "subscription_item",
          current_period_end: fields.periodEnd ?? T + 2_592_000,
          quantity: 1,
          price: {
            currency: "usd",
            unit_amount: fields.unitAmount ?? 2900,
            recurring: { interval: fields.interval ?? "month", interval_count: 1 },
          },
        },
      ],
    },
  };
}

export function subscriptionInvoice(fields: {
  id: string;
  stripeSubscriptionId: string;
  payflowSubscriptionId?: string;
  amountPaid?: number;
  // For invoice.payment_failed:
  amountDue?: number;
  attemptCount?: number;
  nextPaymentAttempt?: number | null;
}) {
  return {
    id: fields.id,
    object: "invoice",
    amount_paid: fields.amountPaid ?? 2900,
    amount_due: fields.amountDue ?? 2900,
    attempt_count: fields.attemptCount ?? 1,
    next_payment_attempt: fields.nextPaymentAttempt ?? null,
    currency: "usd",
    parent: {
      type: "subscription_details",
      quote_details: null,
      subscription_details: {
        subscription: fields.stripeSubscriptionId,
        metadata: fields.payflowSubscriptionId
          ? { [SUBSCRIPTION_METADATA_KEY]: fields.payflowSubscriptionId }
          : {},
      },
    },
  };
}

export function stripeRefund(fields: {
  id: string;
  status: string;
  amount?: number;
  paymentIntent?: string;
  // Our row id, as PayFlow puts it into the metadata of refunds it creates.
  payflowRefundId?: string;
  failureReason?: string;
}) {
  return {
    id: fields.id,
    object: "refund",
    status: fields.status,
    amount: fields.amount ?? 500,
    currency: "usd",
    payment_intent: fields.paymentIntent ?? "pi_test_1",
    charge: "ch_test_1",
    failure_reason: fields.failureReason ?? null,
    metadata: fields.payflowRefundId ? { payflowRefundId: fields.payflowRefundId } : {},
  };
}
