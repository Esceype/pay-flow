import { UnrecoverableError, Worker, type Job } from "bullmq";
import { env } from "../lib/env";
import { getQueueRedis } from "../lib/redis";
import { prisma } from "../lib/prisma";
import { QUEUE_NAMES } from "../lib/queue";
import { handleWebhookEvent } from "./handle-webhook-event";
import { startAdminServer } from "./server";

interface WebhookJobData {
  webhookEventId: string;
}

const worker = new Worker(
  QUEUE_NAMES.webhookEvents,
  (job: Job<WebhookJobData>) => handleWebhookEvent(job.data.webhookEventId),
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
