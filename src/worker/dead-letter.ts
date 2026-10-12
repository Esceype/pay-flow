import { prisma } from "../lib/prisma";
import { getWebhookEventsQueue } from "../lib/queue";

// Dead-letter handling for webhook events (ADR-009): recording why an event
// failed, and putting a failed event back through the pipeline.

// Postgres has no trouble with long text, but a stack-sized error message
// in every list query is noise. The full error is in the logs.
const MAX_ERROR_LENGTH = 1000;

const errorMessage = (err: unknown) =>
  (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, MAX_ERROR_LENGTH);

// Called for every failed attempt of a webhook-event job.
//
//   final = false  another retry is coming: keep the status (PROCESSING
//                  reads as "in flight"), but note the error so a slow
//                  failure is visible before it becomes a dead letter
//   final = true   retries exhausted, or the error was unrecoverable: the
//                  event is a dead letter until someone replays it
//
// Never touches a PROCESSED event. A job can fail *after* its event was
// processed — when only the follow-up signals couldn't be enqueued — and
// that is not the event failing.
export async function recordWebhookEventFailure(
  webhookEventId: string,
  err: unknown,
  final: boolean
): Promise<void> {
  await prisma.webhookEvent.updateMany({
    where: { id: webhookEventId, status: { not: "PROCESSED" } },
    data: {
      lastError: errorMessage(err),
      ...(final && { status: "FAILED", failedAt: new Date() }),
    },
  });
}

export type ReplayResult = "replayed" | "not_found" | "not_failed";

// Puts a dead-lettered event back through the pipeline. Safe by
// construction: every processor is idempotent, so replaying an event whose
// effects were partly or even fully applied changes nothing it shouldn't.
//
// Only FAILED events can be replayed. Anything else is either done or
// still in flight, and the conditional UPDATE makes two people clicking
// "Replay" at once replay it once.
export async function replayWebhookEvent(webhookEventId: string): Promise<ReplayResult> {
  const { count } = await prisma.webhookEvent.updateMany({
    where: { id: webhookEventId, status: "FAILED" },
    // lastError is kept until the event actually succeeds: if the replay
    // fails too, the list shows the new error; if not, the handler clears it.
    data: { status: "RECEIVED", failedAt: null },
  });
  if (count === 0) {
    const exists = await prisma.webhookEvent.findUnique({
      where: { id: webhookEventId },
      select: { id: true },
    });
    return exists ? "not_failed" : "not_found";
  }

  const event = await prisma.webhookEvent.findUniqueOrThrow({
    where: { id: webhookEventId },
    select: { type: true },
  });

  // The job that failed is still in BullMQ's failed set under the same
  // jobId, and add() is a no-op while a job with that id exists.
  //
  // If Redis is unreachable here, the row is already RECEIVED and the relay
  // finishes the job: it finds either no job (and enqueues one) or the old
  // failed one (and marks the event FAILED again, so the replay visibly
  // didn't happen rather than silently hanging).
  const queue = getWebhookEventsQueue();
  const previous = await queue.getJob(webhookEventId);
  if (previous) await previous.remove();
  await queue.add(event.type, { webhookEventId }, { jobId: webhookEventId });

  return "replayed";
}
