import { vi } from "vitest";

// Stand-ins for the two BullMQ queues, installed for every integration test
// by test/integration/setup.ts. They record what the code under test asked
// to have done — which is what the tests assert on — and keep test jobs out
// of any real queue a development worker might be consuming.
export const webhookEventsQueue = {
  add: vi.fn(),
};

export const revenueStatsQueue = {
  add: vi.fn(),
  addBulk: vi.fn(),
};

export function resetQueues(): void {
  webhookEventsQueue.add.mockReset().mockResolvedValue(undefined);
  revenueStatsQueue.add.mockReset().mockResolvedValue(undefined);
  revenueStatsQueue.addBulk.mockReset().mockResolvedValue([]);
}
