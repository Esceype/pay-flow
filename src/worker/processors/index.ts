import type { WebhookEvent } from "@prisma/client";
import { processCheckoutSessionCompleted } from "./checkout-session-completed";

type Processor = (webhookEvent: WebhookEvent) => Promise<void>;

// Registry of handled Stripe event types. Anything not listed here is
// acknowledged (WebhookEvent marked PROCESSED) without further action —
// deliberately, since the Connect endpoint receives every event type from
// every connected account, and most aren't relevant yet (subscriptions:
// Phase 4; refunds/disputes: not yet scoped). Silently accepting unhandled
// types is correct: it's not a failure, just nothing to do yet.
const processors: Partial<Record<string, Processor>> = {
  "checkout.session.completed": processCheckoutSessionCompleted,
};

export function getProcessor(eventType: string): Processor | undefined {
  return processors[eventType];
}
