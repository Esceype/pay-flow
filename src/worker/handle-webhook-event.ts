import type { WebhookEvent } from "@prisma/client";
import { UnrecoverableError } from "bullmq";
import { log, withLogContext } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { getNotificationsQueue, getRevenueStatsQueue, REVENUE_STATS_JOBS } from "../lib/queue";
import { getRegistration, type Registration } from "./processors";

// What the BullMQ worker runs for each job. Lives in its own module (not
// inline in index.ts) so tests can call it directly: importing index.ts
// starts real Workers and the admin server.
export async function handleWebhookEvent(webhookEventId: string): Promise<void> {
  const webhookEvent = await prisma.webhookEvent.findUnique({
    where: { id: webhookEventId },
  });
  if (!webhookEvent) {
    // The job only carries an id; without the durable row there is
    // nothing to process, and retrying won't make it appear.
    throw new UnrecoverableError(`WebhookEvent ${webhookEventId} not found`);
  }

  // Everything logged from here down — by this function, the processor, or
  // anything they call — carries these fields. stripeEventId is the one to
  // search by: the webhook route logs under it too.
  await withLogContext(
    {
      webhookEventId,
      stripeEventId: webhookEvent.stripeEventId,
      eventType: webhookEvent.type,
      stripeAccountId: webhookEvent.stripeAccountId,
      userId: webhookEvent.userId,
    },
    async () => {
      try {
        await processWebhookEvent(webhookEvent);
      } catch (err) {
        // Logged here, not only by the worker's `failed` listener: this is
        // the last place the failure still has its context (event id,
        // tenant) attached. The listener decides what the failure means
        // for the event — retry or dead letter.
        log.error("webhook event attempt failed", { err });
        throw err;
      }
    }
  );
}

async function processWebhookEvent(webhookEvent: WebhookEvent): Promise<void> {
  const registration = getRegistration(webhookEvent.type);

  if (webhookEvent.status === "PROCESSED") {
    // Re-enqueued job for an event already finished (ADR-001's jobId
    // dedup covers the common case, but isn't airtight against every
    // retry timing) — nothing to process again. The follow-up signals are
    // still sent: this is also the path a job takes when the worker died
    // after the processor committed but before the signals went out.
    await signalFollowUps(webhookEvent, registration);
    return;
  }

  const startedAt = Date.now();

  await prisma.webhookEvent.update({
    where: { id: webhookEvent.id },
    data: { status: "PROCESSING" },
  });

  await registration?.process?.(webhookEvent);

  await prisma.webhookEvent.update({
    where: { id: webhookEvent.id },
    // Clears whatever an earlier, failed attempt (or a replayed dead
    // letter) left behind.
    data: { status: "PROCESSED", processedAt: new Date(), lastError: null, failedAt: null },
  });

  log.info("webhook event processed", {
    handled: Boolean(registration?.process),
    durationMs: Date.now() - startedAt,
  });

  await signalFollowUps(webhookEvent, registration);
}

// Work that follows from an event but isn't part of it, each on its own
// queue: recomputing the tenant's revenue stats (ADR-002) and emailing the
// tenant (ADR-010). Sent only after the event's own effects are committed,
// and never inside its transaction — neither may delay or fail a payment
// being recorded.
//
// Delivered at least once: if an enqueue fails the job fails, BullMQ
// retries it, and the retry lands here again. Both consumers are built for
// duplicates: a recompute is idempotent, and a notification is de-duplicated
// by event id.
async function signalFollowUps(
  webhookEvent: WebhookEvent,
  registration: Registration | undefined
): Promise<void> {
  // No tenant, nobody's stats to recompute and nobody to notify.
  if (!registration || !webhookEvent.userId) return;

  if (registration.affectsRevenue) {
    await getRevenueStatsQueue().add(REVENUE_STATS_JOBS.recompute, {
      userId: webhookEvent.userId,
      causedBy: webhookEvent.stripeEventId,
    });
  }
  if (registration.notifies) {
    await getNotificationsQueue().add(webhookEvent.type, { webhookEventId: webhookEvent.id });
  }
}
