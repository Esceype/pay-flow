import type Stripe from "stripe";
import { Prisma } from "@prisma/client";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { addLogContext, log, withLogContext } from "@/lib/logger";
import { getWebhookEventsQueue } from "@/lib/queue";

// Connect webhook endpoint: receives every event from every connected
// account (anything tagged with `event.account`). Its whole job is to make
// the event durable and say so:
//
//   1. verify the signature
//   2. insert the WebhookEvent row            <- the event is now accepted
//   3. enqueue a job pointing at the row      <- best effort, bounded wait
//   4. answer 200
//
// Step 2 is the commitment. Step 3 is only the fast path: if Redis is slow
// or down, the answer is still 200, because the row is safe in Postgres and
// the worker's relay enqueues whatever has no job (ADR-001, amended).
// Nothing here runs business logic — that is the worker's.
export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }
  if (!env.STRIPE_CONNECT_WEBHOOK_SECRET) {
    log.error("webhook: STRIPE_CONNECT_WEBHOOK_SECRET is not configured");
    return new Response("Webhook not configured", { status: 500 });
  }

  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_CONNECT_WEBHOOK_SECRET);
  } catch (err) {
    log.warn("webhook: signature verification failed", { err });
    return new Response("Invalid signature", { status: 400 });
  }

  // `event.account` is the connected account this event originated from —
  // present on every event delivered to a Connect-scoped webhook endpoint.
  const stripeAccountId = event.account ?? null;

  // stripeEventId is the correlation id: the worker logs under it too, so
  // one search shows an event from receipt to its last side effect.
  return withLogContext({ stripeEventId: event.id, eventType: event.type, stripeAccountId }, () =>
    receive(event, stripeAccountId)
  );
}

async function receive(event: Stripe.Event, stripeAccountId: string | null): Promise<Response> {
  const owner = stripeAccountId
    ? await prisma.user.findUnique({ where: { stripeAccountId }, select: { id: true } })
    : null;
  addLogContext({ userId: owner?.id ?? null });

  // Insert-first, not check-then-insert: the unique constraint on
  // stripeEventId is the idempotency guard, and catching its violation
  // avoids a race between two concurrent deliveries of the same event.
  // A database error other than that propagates as a 5xx — we can't accept
  // what we couldn't store, and Stripe will deliver it again.
  let webhookEvent;
  let duplicate = false;
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
      duplicate = true;
      webhookEvent = await prisma.webhookEvent.findUnique({ where: { stripeEventId: event.id } });
    } else {
      throw err;
    }
  }

  if (!webhookEvent) {
    return new Response("Webhook event bookkeeping failed", { status: 500 });
  }
  addLogContext({ webhookEventId: webhookEvent.id });
  // The first line of an event's story in the logs; the worker's lines for
  // it carry the same stripeEventId.
  log.info("webhook: event received", { duplicate, status: webhookEvent.status });

  if (webhookEvent.status === "PROCESSED") {
    // True duplicate delivery of an event we already finished — ack
    // without re-enqueueing.
    return new Response(null, { status: 200 });
  }

  try {
    // jobId = webhookEvent.id makes the enqueue itself idempotent: a
    // redelivery, or the relay enqueueing the same row at the same moment,
    // collapses into the one job that already exists.
    await withTimeout(
      getWebhookEventsQueue().add(
        event.type,
        { webhookEventId: webhookEvent.id },
        { jobId: webhookEvent.id }
      ),
      env.WEBHOOK_ENQUEUE_TIMEOUT_MS
    );
  } catch (err) {
    // Not an error for Stripe: the event is stored. It is processed as soon
    // as the relay runs with Redis reachable, rather than whenever Stripe's
    // own retry schedule (minutes, then hours) would have come round.
    log.warn("webhook: event stored but not enqueued; the relay will deliver it", { err });
  }

  return new Response(null, { status: 200 });
}

// The queue's Redis connection waits for Redis indefinitely (BullMQ needs
// it to), so with Redis down add() would hang, and the request with it
// until Stripe gave up. A promise that loses this race is simply left to
// finish on its own: if it ever succeeds, that is the same job the relay
// would have created.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`enqueue timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
