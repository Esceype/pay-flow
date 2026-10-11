import { UnrecoverableError, Worker, type Job } from "bullmq";
import { env } from "../lib/env";
import { getQueueRedis } from "../lib/redis";
import { prisma } from "../lib/prisma";
import { getRevenueStatsQueue, QUEUE_NAMES, REVENUE_STATS_JOBS } from "../lib/queue";
import { handleWebhookEvent } from "./handle-webhook-event";
import { handleRevenueStatsJob } from "./revenue-stats";
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

  // Not if the event itself was already processed: then its effects are
  // committed and only the follow-up revenue-stats signal failed — the
  // nightly refresh repairs that, and the event did not fail.
  const { webhookEventId } = job.data as WebhookJobData;
  await prisma.webhookEvent
    .updateMany({
      where: { id: webhookEventId, status: { not: "PROCESSED" } },
      data: { status: "FAILED" },
    })
    .catch((updateErr) => {
      console.error(`[worker] failed to mark WebhookEvent ${webhookEventId} as FAILED`, updateErr);
    });
});

// Second consumer, own queue: derived analytics (ADR-002). Kept apart from
// the webhook worker so a backlog of recomputes can never delay payment
// events, and with a small fixed concurrency — recomputes for one tenant
// serialize on a database lock anyway.
const statsWorker = new Worker(QUEUE_NAMES.revenueStats, handleRevenueStatsJob, {
  connection: getQueueRedis(),
  concurrency: 2,
});

statsWorker.on("failed", (job, err) => {
  console.error(`[worker] revenue stats job ${job?.id} (${job?.name}) failed:`, err);
});

async function scheduleRevenueStatsRefresh() {
  const queue = getRevenueStatsQueue();
  // Nightly: churn is measured over a sliding window, so the figures move
  // with time even when no event arrives. upsert = safe to run on every boot
  // and from every worker replica.
  await queue.upsertJobScheduler(
    "nightly-refresh",
    { pattern: "0 3 * * *" },
    { name: REVENUE_STATS_JOBS.refreshAll }
  );
  // And once now, so a deploy that changed the read model repopulates it.
  await queue.add(REVENUE_STATS_JOBS.refreshAll, {});
}

async function shutdown(signal: string) {
  console.log(`[worker] received ${signal}, shutting down...`);
  await Promise.all([worker.close(), statsWorker.close()]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

startAdminServer();
scheduleRevenueStatsRefresh().catch((err) => {
  console.error("[worker] could not schedule the revenue stats refresh", err);
});

console.log(
  "[worker] listening for jobs on queues:",
  QUEUE_NAMES.webhookEvents,
  QUEUE_NAMES.revenueStats
);
