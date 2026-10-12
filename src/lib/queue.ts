import { Queue } from "bullmq";
import { getQueueRedis } from "./redis";

export const QUEUE_NAMES = {
  // Outbox target for every Stripe event received on the Connect webhook
  // endpoint (ADR-001).
  webhookEvents: "webhook-events",
  // Derived data: recomputing a tenant's MaterializedRevenueStats after an
  // event that can change them (ADR-002). A separate queue so analytics
  // work never sits in front of payment events, and vice versa.
  revenueStats: "revenue-stats",
  // Emails to tenants (ADR-010). Its own queue because it talks to a third
  // party: a slow or failing email provider must only ever back up emails.
  // Job data: { webhookEventId } — the event the notification is about.
  notifications: "notifications",
} as const;

export const REVENUE_STATS_JOBS = {
  // data: { userId, causedBy? } — recompute one tenant's stats. causedBy is
  // the Stripe event id that triggered it, for log correlation only.
  recompute: "recompute",
  // No data — enqueue a recompute for every tenant (boot and nightly).
  refreshAll: "refresh-all",
} as const;

let webhookEventsQueueInstance: Queue | undefined;
let revenueStatsQueueInstance: Queue | undefined;
let notificationsQueueInstance: Queue | undefined;

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

export function getRevenueStatsQueue(): Queue {
  return (revenueStatsQueueInstance ??= new Queue(QUEUE_NAMES.revenueStats, {
    connection: getQueueRedis(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { age: 3600, count: 1000 },
      // Unlike a webhook event, a failed recompute loses nothing: the stats
      // are rebuilt from scratch by the next event or the nightly refresh.
      // A week is enough to notice a recurring failure in Bull Board.
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  }));
}

export function getNotificationsQueue(): Queue {
  return (notificationsQueueInstance ??= new Queue(QUEUE_NAMES.notifications, {
    connection: getQueueRedis(),
    defaultJobOptions: {
      // A longer first delay than the other queues: what fails here is
      // usually the provider rate-limiting or briefly down, and hammering
      // it doesn't help.
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { age: 3600, count: 1000 },
      // Kept: an email that could not be sent is something to look at, and
      // it can be retried from Bull Board without sending twice (ADR-010).
      removeOnFail: false,
    },
  }));
}
