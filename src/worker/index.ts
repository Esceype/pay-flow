import { UnrecoverableError, Worker, type Job } from "bullmq";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { getRevenueStatsQueue, QUEUE_NAMES, REVENUE_STATS_JOBS } from "../lib/queue";
import { getQueueRedis } from "../lib/redis";
import { recordWebhookEventFailure } from "./dead-letter";
import { handleWebhookEvent } from "./handle-webhook-event";
import { handleNotificationJob } from "./notifications";
import { startRelay } from "./relay";
import { handleRevenueStatsJob } from "./revenue-stats";
import { startAdminServer } from "./server";

interface WebhookJobData {
  webhookEventId: string;
}

// True once BullMQ will not run the job again: every attempt used up, or
// the handler threw UnrecoverableError (BullMQ skips the remaining retries
// for those).
function isFinalFailure(job: Job, err: Error): boolean {
  const attemptsMax = job.opts.attempts ?? 1;
  return err.name === UnrecoverableError.name || job.attemptsMade >= attemptsMax;
}

// 1. Stripe events -> our tables. The one queue where a lost or failed job
//    is a lost payment, so its failures are recorded on the event itself.
const webhookWorker = new Worker(
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

webhookWorker.on("failed", async (job, err) => {
  if (!job) {
    log.error("webhook job failed without a job reference", { err });
    return;
  }
  const { webhookEventId } = job.data as WebhookJobData;
  const final = isFinalFailure(job, err);

  // The error itself, with the event's full context, was already logged by
  // the handler. What only this listener knows is whether BullMQ is done
  // with the job.
  if (final) {
    log.error("webhook event dead-lettered", {
      queue: QUEUE_NAMES.webhookEvents,
      webhookEventId,
      eventType: job.name,
      attempts: job.attemptsMade,
      reason: err.message,
    });
  }

  // An intermediate failure keeps the event PROCESSING ("in flight") and
  // only notes the error; the final one makes it a dead letter (ADR-009).
  // If this write fails too, the relay reconciles the event with its job.
  await recordWebhookEventFailure(webhookEventId, err, final).catch((recordErr) => {
    log.error("could not record the webhook event failure", { webhookEventId, err: recordErr });
  });
});

// 2. Derived analytics (ADR-002). Kept apart from the webhook worker so a
//    backlog of recomputes can never delay payment events, and with a small
//    fixed concurrency — recomputes for one tenant serialize on a database
//    lock anyway.
const statsWorker = new Worker(QUEUE_NAMES.revenueStats, handleRevenueStatsJob, {
  connection: getQueueRedis(),
  concurrency: 2,
});

// 3. Emails (ADR-010). The only worker that waits on a third party.
const notificationsWorker = new Worker(
  QUEUE_NAMES.notifications,
  (job: Job<WebhookJobData>) => handleNotificationJob(job.data.webhookEventId),
  { connection: getQueueRedis(), concurrency: 2 }
);

for (const [queue, worker] of [
  [QUEUE_NAMES.revenueStats, statsWorker],
  [QUEUE_NAMES.notifications, notificationsWorker],
] as const) {
  worker.on("failed", (job, err) => {
    log.error(job && isFinalFailure(job, err) ? "job failed for good" : "job attempt failed", {
      queue,
      jobId: job?.id,
      jobName: job?.name,
      attempt: job?.attemptsMade,
      err,
    });
  });
}

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

// The outbox relay: on a plain timer, not a queue job — see relay.ts.
const stopRelay = startRelay();

async function shutdown(signal: string) {
  log.info("worker shutting down", { signal });
  stopRelay();
  // close() lets jobs that are running finish before the process exits.
  await Promise.all([webhookWorker.close(), statsWorker.close(), notificationsWorker.close()]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

startAdminServer();
scheduleRevenueStatsRefresh().catch((err) => {
  log.error("could not schedule the revenue stats refresh", { err });
});

log.info("worker started", {
  queues: Object.values(QUEUE_NAMES),
  webhookConcurrency: env.WORKER_CONCURRENCY,
});
