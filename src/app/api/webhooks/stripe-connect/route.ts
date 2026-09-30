import type Stripe from "stripe";
import { Prisma } from "@prisma/client";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { getWebhookEventsQueue } from "@/lib/queue";

// Connect webhook endpoint: receives every payment-relevant event from
// every connected account (checkout, invoices, subscriptions — anything
// tagged with `event.account`). Routed through the transactional outbox +
// BullMQ pipeline — see docs/adr/001-outbox-pattern.md for what
// "transactional" actually means here (spoiler: not a literal cross-system
// transaction) and docs/adr/003-stripe-connect-multitenancy.md for why this
// is a separate endpoint/secret from the platform one.
export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }
  if (!env.STRIPE_CONNECT_WEBHOOK_SECRET) {
    console.error("[stripe-connect webhook] STRIPE_CONNECT_WEBHOOK_SECRET is not configured");
    return new Response("Webhook not configured", { status: 500 });
  }

  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_CONNECT_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[stripe-connect webhook] signature verification failed", err);
    return new Response("Invalid signature", { status: 400 });
  }

  // `event.account` is the connected account this event originated from —
  // present on every event delivered to a Connect-scoped webhook endpoint,
  // regardless of event type (unlike account.updated on the platform
  // endpoint, where the account IS data.object itself).
  const stripeAccountId = event.account ?? null;
  const owner = stripeAccountId
    ? await prisma.user.findUnique({ where: { stripeAccountId }, select: { id: true } })
    : null;

  let webhookEvent;
  try {
    webhookEvent = await prisma.webhookEvent.create({
      data: {
        stripeEventId: event.id,
        stripeAccountId,
        userId: owner?.id,
        type: event.type,
        payload: event as unknown as Prisma.InputJsonValue,
        status: "RECEIVED",
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      webhookEvent = await prisma.webhookEvent.findUnique({ where: { stripeEventId: event.id } });
    } else {
      throw err;
    }
  }

  if (!webhookEvent) {
    return new Response("Webhook event bookkeeping failed", { status: 500 });
  }

  if (webhookEvent.status === "PROCESSED") {
    // True duplicate delivery of an event we already finished — ack
    // without re-enqueueing.
    return new Response(null, { status: 200 });
  }

  try {
    // jobId = webhookEvent.id makes the enqueue itself idempotent: if a
    // prior attempt already got this far (e.g. this is a Stripe retry after
    // the DB insert succeeded but something failed before we could
    // respond), BullMQ rejects the duplicate jobId rather than creating a
    // second job — see ADR-001.
    await getWebhookEventsQueue().add(
      event.type,
      { webhookEventId: webhookEvent.id },
      { jobId: webhookEvent.id }
    );
  } catch (err) {
    console.error("[stripe-connect webhook] failed to enqueue job", err);
    // Non-2xx so Stripe retries — that retry is the recovery path for a
    // transient Redis failure here (ADR-001). The WebhookEvent row already
    // exists, so the retry's insert attempt will hit it and try to enqueue
    // again instead of duplicating the record.
    return new Response("Failed to enqueue for processing", { status: 500 });
  }

  return new Response(null, { status: 200 });
}
