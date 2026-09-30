import type Stripe from "stripe";
import { Prisma } from "@prisma/client";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { syncConnectAccountStatus } from "@/lib/stripe-connect";

// Platform webhook endpoint: receives ONLY account.updated (Connect
// onboarding/capability status changes). Handled synchronously, no outbox
// or BullMQ — see docs/adr/003-stripe-connect-multitenancy.md for why this
// endpoint is intentionally exempt from the outbox pattern that the
// Connect webhook endpoint (Phase 2) will use for payment events.
export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }
  if (!env.STRIPE_WEBHOOK_SECRET) {
    console.error("[stripe-platform webhook] STRIPE_WEBHOOK_SECRET is not configured");
    return new Response("Webhook not configured", { status: 500 });
  }

  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[stripe-platform webhook] signature verification failed", err);
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type !== "account.updated") {
    // The Stripe Dashboard should only ever subscribe this endpoint to
    // account.updated — anything else arriving here is a configuration
    // mismatch, not a payment event, so it's logged and acknowledged
    // rather than retried.
    console.warn(`[stripe-platform webhook] unexpected event type: ${event.type}`);
    return new Response(null, { status: 200 });
  }

  const account = event.data.object as Stripe.Account;
  const owner = await prisma.user.findUnique({
    where: { stripeAccountId: account.id },
    select: { id: true },
  });

  // Insert-first, not check-then-insert: catching the unique constraint
  // violation avoids a TOCTOU race if Stripe ever delivers the same event
  // concurrently on two connections.
  let webhookEvent;
  try {
    webhookEvent = await prisma.webhookEvent.create({
      data: {
        stripeEventId: event.id,
        stripeAccountId: account.id,
        userId: owner?.id,
        type: event.type,
        payload: event as unknown as Prisma.InputJsonValue,
        status: "PROCESSING",
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.webhookEvent.findUnique({
        where: { stripeEventId: event.id },
      });
      if (existing?.status === "PROCESSED") {
        // True duplicate delivery of an event we already finished — ack
        // without reprocessing.
        return new Response(null, { status: 200 });
      }
      // A previous attempt inserted the row but never reached PROCESSED
      // (crashed mid-request, or failed) — fall through and retry it for
      // real rather than silently dropping Stripe's retry.
      webhookEvent = existing;
    } else {
      throw err;
    }
  }

  if (!webhookEvent) {
    return new Response("Webhook event bookkeeping failed", { status: 500 });
  }

  try {
    await syncConnectAccountStatus(account.id);
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
  } catch (err) {
    await prisma.webhookEvent
      .update({ where: { id: webhookEvent.id }, data: { status: "FAILED" } })
      .catch(() => {});
    console.error("[stripe-platform webhook] processing failed", err);
    // Non-2xx so Stripe retries — the idempotency check above ensures a
    // retry resumes rather than double-applies.
    return new Response("Processing failed", { status: 500 });
  }

  return new Response(null, { status: 200 });
}
