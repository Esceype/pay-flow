import { Queue } from "bullmq";
import { getQueueRedis } from "./redis";

export const QUEUE_NAMES = {
  // Outbox target for Connect webhook events (payment-relevant). The
  // platform endpoint's account.updated event does NOT go through this
  // queue — it's handled synchronously (see ADR-003).
  webhookEvents: "webhook-events",
} as const;

let webhookEventsQueueInstance: Queue | undefined;

// Lazy singleton for the same reason as getQueueRedis(): constructing a
// Queue touches its Redis connection immediately, which must not happen at
// module-import time.
export function getWebhookEventsQueue(): Queue {
  return (webhookEventsQueueInstance ??= new Queue(QUEUE_NAMES.webhookEvents, {
    connection: getQueueRedis(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
      // Keep completed jobs around briefly so Bull Board is actually useful
      // for spot-checking recent activity, then let them drop.
      removeOnComplete: { age: 3600 },
      // Failed jobs are kept indefinitely (the dead-letter view in Bull
      // Board; WebhookEvent is also marked FAILED) — losing a failed payment
      // webhook silently is not acceptable.
      removeOnFail: false,
    },
  }));
}
