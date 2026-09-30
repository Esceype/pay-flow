import { UnrecoverableError, Worker, type Job } from "bullmq";
import { env } from "../lib/env";
import { getQueueRedis } from "../lib/redis";
import { prisma } from "../lib/prisma";
import { QUEUE_NAMES } from "../lib/queue";
import { getProcessor } from "./processors";
import { startAdminServer } from "./server";

interface WebhookJobData {
  webhookEventId: string;
}

const worker = new Worker(
  QUEUE_NAMES.webhookEvents,
  async (job: Job<WebhookJobData>) => {
    const { webhookEventId } = job.data;

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
  },
  {
    connection: getQueueRedis(),
    // Backpressure: caps how many jobs run concurrently so a traffic spike
    // makes the queue grow instead of overwhelming Postgres with concurrent
    // writes.
    concurrency: env.WORKER_CONCURRENCY,
  }
);

worker.on("completed", (job) => {
  console.log(`[worker] completed job ${job.id} (${job.name})`);
});

worker.on("failed", async (job, err) => {
  console.error(`[worker] job ${job?.id} (${job?.name}) failed:`, err);

  if (!job) return;

  // Only mark the WebhookEvent FAILED once the job is actually dead: every
  // retry attempt exhausted, or a processor threw UnrecoverableError
  // (BullMQ skips the remaining retries for those). An intermediate failure
  // still has retries coming (exponential backoff, src/lib/queue.ts) and
  // should stay PROCESSING so it reads as "in flight," not "dead."
  const attemptsMax = job.opts.attempts ?? 1;
  const unrecoverable = err.name === UnrecoverableError.name;
  if (!unrecoverable && job.attemptsMade < attemptsMax) return;

  const { webhookEventId } = job.data as WebhookJobData;
  await prisma.webhookEvent
    .update({ where: { id: webhookEventId }, data: { status: "FAILED" } })
    .catch((updateErr) => {
      console.error(`[worker] failed to mark WebhookEvent ${webhookEventId} as FAILED`, updateErr);
    });
});

async function shutdown(signal: string) {
  console.log(`[worker] received ${signal}, shutting down...`);
  await worker.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

startAdminServer();

console.log("[worker] listening for jobs on queue:", QUEUE_NAMES.webhookEvents);
