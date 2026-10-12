import type Stripe from "stripe";
import type { WebhookEvent } from "@prisma/client";
import { UnrecoverableError } from "bullmq";
import { log } from "../../lib/logger";
import { syncConnectAccountStatus, unlinkConnectAccount } from "../../lib/stripe-connect";

// account.updated for a connected account is a Connected-accounts scoped
// event — Stripe delivers it to the Connect endpoint, not a platform
// ("Your account") endpoint — so it arrives through the same outbox
// pipeline as payment events (ADR-003, amended).
export async function processAccountUpdated(webhookEvent: WebhookEvent): Promise<void> {
  const event = webhookEvent.payload as unknown as Stripe.AccountUpdatedEvent;
  const stripeAccountId = event.account ?? event.data.object.id;

  const onboardingComplete = await syncConnectAccountStatus(stripeAccountId);
  if (onboardingComplete === null) {
    log.info("account.updated for an account not linked to any user");
  }
}

export async function processAccountDeauthorized(webhookEvent: WebhookEvent): Promise<void> {
  const event = webhookEvent.payload as unknown as Stripe.AccountApplicationDeauthorizedEvent;
  if (!event.account) {
    // Retrying can't make the field appear.
    throw new UnrecoverableError("account.application.deauthorized without an `account` field");
  }

  const unlinked = await unlinkConnectAccount(event.account, new Date(event.created * 1000));
  if (!unlinked) {
    // Either the account isn't linked anymore, or the tenant reconnected
    // after this deauthorization happened — stale event, correctly ignored.
    log.info("deauthorization had nothing to unlink");
  }
}
