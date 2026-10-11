import { afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { getCacheRedis } from "@/lib/redis";
import { resetDatabase } from "../db";
import { resetQueues } from "../queues";
import { closeTestRedis, getTestRedis, resetRedis } from "../redis";

// What is real and what isn't, for every integration test:
//
//   Postgres  real — the `payflow_test` database (test/global-setup.ts).
//   Redis     real for the cache and the rate limiter, on logical db 15.
//   Queues    fake (test/queues.ts): the tests assert on what was enqueued
//             and run jobs through the handlers themselves.
//   Stripe    never called; individual calls are spied where needed.

vi.mock("@/lib/redis", async () => {
  const { getTestRedis } = await import("../redis");
  return {
    getCacheRedis: vi.fn(getTestRedis),
    getQueueRedis: () => {
      throw new Error("The queue's Redis connection must not be used in tests.");
    },
  };
});

vi.mock("@/lib/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queue")>();
  const { webhookEventsQueue, revenueStatsQueue } = await import("../queues");
  return {
    ...actual,
    getWebhookEventsQueue: () => webhookEventsQueue,
    getRevenueStatsQueue: () => revenueStatsQueue,
  };
});

// Every test starts from an empty database, an empty Redis db and fresh
// fakes. The processors log what they skip and why; that is expected output
// here, so it's kept out of the test report.
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resetQueues();
  // A test may have swapped in an unreachable Redis.
  vi.mocked(getCacheRedis).mockReset().mockImplementation(getTestRedis);
  await Promise.all([resetDatabase(), resetRedis()]);
});

afterAll(async () => {
  await Promise.all([prisma.$disconnect(), closeTestRedis()]);
});
