import { log } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { getWebhookEventsQueue } from "../lib/queue";
import { recordWebhookEventFailure } from "./dead-letter";

// The outbox relay (ADR-001, amended; ADR-009).
//
// Postgres and Redis can't be written in one transaction, so a WebhookEvent
// row can exist without a job to process it: Redis was down when the
// webhook arrived, the process died between the two writes, or Redis lost
// its data. The row is the durable record; the job is only a pointer to
// it. The relay makes the pointers match the rows again.
//
// It deliberately does NOT run as a BullMQ job. Something that exists to
// repair the queue shouldn't depend on the queue's own scheduler surviving
// whatever broke the queue — it runs on a plain timer in the worker process
// (see index.ts).

// Long enough that a healthy event is never touched: the job's own retries
// (exponential backoff, about 30s in total) finish well inside it.
export const STALE_AFTER_MS = 5 * 60 * 1000;

// Oldest first, a bounded number per run. A large backlog is worked through
// over several runs instead of in one unbounded query.
const BATCH_SIZE = 200;

export interface RelayResult {
  // No job existed for the event: one was enqueued.
  requeued: number;
  // The job had failed for good but the event didn't say so: now it does.
  markedFailed: number;
  // A job exists and is waiting, running or backing off: nothing to do.
  inFlight: number;
}

export async function relayStuckWebhookEvents(now: Date = new Date()): Promise<RelayResult> {
  const result: RelayResult = { requeued: 0, markedFailed: 0, inFlight: 0 };

  const stuck = await prisma.webhookEvent.findMany({
    where: {
      status: { in: ["RECEIVED", "PROCESSING"] },
      receivedAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) },
    },
    orderBy: { receivedAt: "asc" },
    take: BATCH_SIZE,
    select: { id: true, type: true, stripeEventId: true },
  });
  if (stuck.length === 0) return result;

  const queue = getWebhookEventsQueue();

  for (const event of stuck) {
    const job = await queue.getJob(event.id);

    if (!job) {
      // The lost-job case. jobId = row id, as in the webhook route, so if
      // the route's own enqueue lands at the same moment there is still
      // only one job.
      await queue.add(event.type, { webhookEventId: event.id }, { jobId: event.id });
      result.requeued++;
      log.warn("relay: re-enqueued an event that had no job", {
        webhookEventId: event.id,
        stripeEventId: event.stripeEventId,
      });
      continue;
    }

    const state = await job.getState();

    if (state === "failed") {
      // BullMQ gave up on it, but the worker never recorded that — it died
      // first, or the database was unreachable at that moment.
      await recordWebhookEventFailure(event.id, new Error(job.failedReason || "job failed"), true);
      result.markedFailed++;
      log.warn("relay: marked an event FAILED to match its job", {
        webhookEventId: event.id,
        stripeEventId: event.stripeEventId,
      });
    } else if (state === "completed") {
      // The handler marks the event PROCESSED before its job completes, so
      // this shouldn't be reachable. If it ever is, the event wasn't
      // processed whatever the job says: run it again.
      await job.remove();
      await queue.add(event.type, { webhookEventId: event.id }, { jobId: event.id });
      result.requeued++;
      log.error("relay: job completed but its event was not processed; re-enqueued", {
        webhookEventId: event.id,
        stripeEventId: event.stripeEventId,
      });
    } else {
      result.inFlight++;
    }
  }

  return result;
}

// Runs the relay on a timer for as long as the process lives. Returns a
// function that stops it.
export function startRelay(intervalMs: number = 60_000): () => void {
  let running = false;

  const tick = async () => {
    // A run can outlast the interval — with Redis down, its queue calls
    // wait for Redis to come back — and must not pile up behind itself.
    if (running) return;
    running = true;
    try {
      const result = await relayStuckWebhookEvents();
      if (result.requeued > 0 || result.markedFailed > 0) {
        log.info("relay: run finished", { ...result });
      }
    } catch (err) {
      // Expected while Redis or Postgres is down — which is exactly when
      // there is something for the next run to pick up.
      log.warn("relay: run failed, will try again", { err });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Once shortly after boot too, rather than a full interval later.
  const first = setTimeout(() => void tick(), 5_000);
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
