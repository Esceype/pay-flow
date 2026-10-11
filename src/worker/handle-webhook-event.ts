import type { WebhookEvent } from "@prisma/client";
import { UnrecoverableError } from "bullmq";
import { prisma } from "../lib/prisma";
import { getRevenueStatsQueue, REVENUE_STATS_JOBS } from "../lib/queue";
import { getRegistration, type Registration } from "./processors";

// What the BullMQ worker runs for each job. Lives in its own module (not
// inline in index.ts) so tests can call it directly: importing index.ts
// starts a real Worker and the admin server.
export async function handleWebhookEvent(webhookEventId: string): Promise<void> {
  const webhookEvent = await prisma.webhookEvent.findUnique({
    where: { id: webhookEventId },
  });
  if (!webhookEvent) {
    // The job only carries an id; without the durable row there is
    // nothing to process, and retrying won't make it appear.
    throw new UnrecoverableError(`WebhookEvent ${webhookEventId} not found`);
  }

  const registration = getRegistration(webhookEvent.type);

  if (webhookEvent.status === "PROCESSED") {
    // Re-enqueued job for an event already finished (ADR-001's jobId
    // dedup covers the common case, but isn't airtight against every
    // retry timing) — nothing to process again. The recompute signal is
    // still sent: this is also the path a job takes when the worker died
    // after the processor committed but before the signal went out.
    await signalRevenueChange(webhookEvent, registration);
    return;
  }

  await prisma.webhookEvent.update({
    where: { id: webhookEventId },
    data: { status: "PROCESSING" },
  });

  if (registration) {
    await registration.process(webhookEvent);
  } else {
    console.log(`[worker] no processor registered for ${webhookEvent.type} — acknowledging`);
  }

  await prisma.webhookEvent.update({
    where: { id: webhookEventId },
    data: { status: "PROCESSED", processedAt: new Date() },
  });

  await signalRevenueChange(webhookEvent, registration);
}

// Asks for the tenant's revenue stats to be recomputed, after the event's
// own effects are committed. Analytics are derived data and eventually
// consistent (ADR-002): this is a second, separate job, not part of the
// event's transaction.
//
// Delivered at least once: if this enqueue fails the job fails, BullMQ
// retries it, and the retry lands here again. A duplicate signal just
// recomputes the same figures twice.
async function signalRevenueChange(
  webhookEvent: WebhookEvent,
  registration: Registration | undefined
): Promise<void> {
  if (!registration?.affectsRevenue || !webhookEvent.userId) return;

  await getRevenueStatsQueue().add(REVENUE_STATS_JOBS.recompute, {
    userId: webhookEvent.userId,
  });
}
