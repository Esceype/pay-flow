import type { WebhookEvent } from "@prisma/client";
import { processAccountDeauthorized, processAccountUpdated } from "./account";
import { processCheckoutSessionEvent } from "./checkout-session";
import { processSubscriptionEvent, processSubscriptionInvoicePaid } from "./subscription";

type Processor = (webhookEvent: WebhookEvent) => Promise<void>;

// Registry of handled Stripe event types. Anything not listed here is
// acknowledged (WebhookEvent marked PROCESSED) without further action —
// deliberately, since the Connect endpoint receives every event type from
// every connected account, and most aren't relevant (refunds/disputes: not
// yet scoped). Silently accepting unhandled types is correct: it's not a
// failure, just nothing to do.
//
// Each of these must be enabled on the Connect webhook endpoint in the
// Stripe Dashboard (see README).
const processors: Partial<Record<string, Processor>> = {
  "account.updated": processAccountUpdated,
  "account.application.deauthorized": processAccountDeauthorized,
  "checkout.session.completed": processCheckoutSessionEvent,
  "checkout.session.async_payment_succeeded": processCheckoutSessionEvent,
  "checkout.session.async_payment_failed": processCheckoutSessionEvent,
  "checkout.session.expired": processCheckoutSessionEvent,
  "customer.subscription.created": processSubscriptionEvent,
  "customer.subscription.updated": processSubscriptionEvent,
  "customer.subscription.deleted": processSubscriptionEvent,
  "invoice.paid": processSubscriptionInvoicePaid,
};

export function getProcessor(eventType: string): Processor | undefined {
  return processors[eventType];
}
