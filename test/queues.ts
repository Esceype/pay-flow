import { vi } from "vitest";

// Stand-ins for the BullMQ queues, installed for every integration test by
// test/integration/setup.ts. They record what the code under test asked to
// have done — which is what the tests assert on — and keep test jobs out of
// any real queue a development worker might be consuming.
export const webhookEventsQueue = {
  add: vi.fn(),
  // What the relay and replay ask: "is there a job for this event, and in
  // what state?" No job unless a test says otherwise (see fakeJob()).
  getJob: vi.fn(),
};

export const revenueStatsQueue = {
  add: vi.fn(),
  addBulk: vi.fn(),
};

export const notificationsQueue = {
  add: vi.fn(),
};

export function resetQueues(): void {
  webhookEventsQueue.add.mockReset().mockResolvedValue(undefined);
  webhookEventsQueue.getJob.mockReset().mockResolvedValue(undefined);
  revenueStatsQueue.add.mockReset().mockResolvedValue(undefined);
  revenueStatsQueue.addBulk.mockReset().mockResolvedValue([]);
  notificationsQueue.add.mockReset().mockResolvedValue(undefined);
}

// A job as the relay and replay see one: its state, why it failed, and a
// way to remove it.
export function fakeJob(
  state: "waiting" | "active" | "delayed" | "completed" | "failed",
  failedReason = ""
) {
  return { getState: vi.fn().mockResolvedValue(state), failedReason, remove: vi.fn() };
}
