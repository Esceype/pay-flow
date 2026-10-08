import { UnrecoverableError } from "bullmq";
import { prisma } from "../lib/prisma";
import { getProcessor } from "./processors";

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

  if (webhookEvent.status === "PROCESSED") {
    // Re-enqueued job for an event already finished (ADR-001's jobId
    // dedup covers the common case, but isn't airtight against every
    // retry timing) — idempotent no-op.
    return;
  }

  await prisma.webhookEvent.update({
    where: { id: webhookEventId },
    data: { status: "PROCESSING" },
  });

  const processor = getProcessor(webhookEvent.type);
  if (processor) {
    await processor(webhookEvent);
  } else {
    console.log(`[worker] no processor registered for ${webhookEvent.type} — acknowledging`);
  }

  await prisma.webhookEvent.update({
    where: { id: webhookEventId },
    data: { status: "PROCESSED", processedAt: new Date() },
  });
}
