import type { WebhookEvent } from "@prisma/client";
import { processAccountDeauthorized, processAccountUpdated } from "./account";
import { processCheckoutSessionEvent } from "./checkout-session";
import { processSubscriptionEvent, processSubscriptionInvoicePaid } from "./subscription";

type Processor = (webhookEvent: WebhookEvent) => Promise<void>;

export interface Registration {
  process: Processor;
  // Set for events that can change what MaterializedRevenueStats is
  // computed from (a Transaction, or a subscription's status or price).
  // After such an event the worker asks for that tenant's stats to be
  // recomputed — see handle-webhook-event.ts and ADR-002.
  affectsRevenue?: true;
}

// Registry of handled Stripe event types. Anything not listed here is
// acknowledged (WebhookEvent marked PROCESSED) without further action —
// deliberately, since the Connect endpoint receives every event type from
// every connected account, and most aren't relevant (refunds/disputes: not
// yet scoped). Silently accepting unhandled types is correct: it's not a
// failure, just nothing to do.
//
// Each of these must be enabled on the Connect webhook endpoint in the
// Stripe Dashboard (see README).
const registrations: Partial<Record<string, Registration>> = {
  "account.updated": { process: processAccountUpdated },
  "account.application.deauthorized": { process: processAccountDeauthorized },
  "checkout.session.completed": { process: processCheckoutSessionEvent, affectsRevenue: true },
  "checkout.session.async_payment_succeeded": {
    process: processCheckoutSessionEvent,
    affectsRevenue: true,
  },
  // Status-only for the invoice: no Transaction, so no revenue change.
  "checkout.session.async_payment_failed": { process: processCheckoutSessionEvent },
  "checkout.session.expired": { process: processCheckoutSessionEvent },
  "customer.subscription.created": { process: processSubscriptionEvent, affectsRevenue: true },
  "customer.subscription.updated": { process: processSubscriptionEvent, affectsRevenue: true },
  "customer.subscription.deleted": { process: processSubscriptionEvent, affectsRevenue: true },
  "invoice.paid": { process: processSubscriptionInvoicePaid, affectsRevenue: true },
};

export function getRegistration(eventType: string): Registration | undefined {
  return registrations[eventType];
}
