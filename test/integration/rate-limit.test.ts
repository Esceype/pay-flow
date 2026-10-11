import { describe, expect, it, vi } from "vitest";
import { consumeRateLimit, type RateLimitRule } from "@/lib/rate-limit";
import { getCacheRedis } from "@/lib/redis";
import { getTestRedis, unreachableRedis } from "../redis";

// The token bucket itself is a Lua script, so it's tested where it runs:
// against a real Redis. Rules here refill either very fast or practically
// never, so the tests don't depend on precise timing.
const frozen = (capacity: number): RateLimitRule => ({
  name: "test-frozen",
  capacity,
  refillPerSecond: 0.001,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("consumeRateLimit", () => {
  it("allows a burst up to the bucket's capacity, then rejects", async () => {
    const rule = frozen(3);

    const results = [];
    for (let i = 0; i < 5; i++) results.push(await consumeRateLimit(rule, "tenant-1"));

    expect(results.map((result) => result.allowed)).toEqual([true, true, true, false, false]);
    expect(results.slice(0, 3).map((result) => result.remaining)).toEqual([2, 1, 0]);
  });

  it("refills over time", async () => {
    const rule: RateLimitRule = { name: "test-fast", capacity: 2, refillPerSecond: 20 };
    await consumeRateLimit(rule, "tenant-1");
    await consumeRateLimit(rule, "tenant-1");
    expect((await consumeRateLimit(rule, "tenant-1")).allowed).toBe(false);

    await sleep(200); // 20 tokens/s: comfortably more than one token later

    expect((await consumeRateLimit(rule, "tenant-1")).allowed).toBe(true);
  });

  it("never refills beyond capacity", async () => {
    // 20 tokens/s, capacity 4: the key lives 200ms, so the second request
    // below still finds the same bucket rather than a brand-new one.
    const rule: RateLimitRule = { name: "test-cap", capacity: 4, refillPerSecond: 20 };
    await consumeRateLimit(rule, "tenant-1"); // 3 left
    await sleep(100); // +2 tokens: 5, were there no cap

    const result = await consumeRateLimit(rule, "tenant-1");

    // Took one from a full bucket of 4 — not from 5.
    expect(result).toMatchObject({ allowed: true, remaining: 3 });
  });

  it("says how long until the next token when it rejects", async () => {
    const rule: RateLimitRule = { name: "test-slow", capacity: 1, refillPerSecond: 0.5 };
    await consumeRateLimit(rule, "tenant-1");

    const rejected = await consumeRateLimit(rule, "tenant-1");

    expect(rejected).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 2 });
  });

  it("keeps a separate bucket per subject and per rule", async () => {
    const rule = frozen(1);
    const otherRule: RateLimitRule = { ...frozen(1), name: "test-other" };

    expect((await consumeRateLimit(rule, "tenant-1")).allowed).toBe(true);
    expect((await consumeRateLimit(rule, "tenant-1")).allowed).toBe(false);

    expect((await consumeRateLimit(rule, "tenant-2")).allowed).toBe(true);
    expect((await consumeRateLimit(otherRule, "tenant-1")).allowed).toBe(true);
  });

  it("spends each token exactly once when requests arrive at the same time", async () => {
    const rule = frozen(5);

    const results = await Promise.all(
      Array.from({ length: 25 }, () => consumeRateLimit(rule, "tenant-1"))
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
  });

  it("lets an idle bucket expire instead of keeping it forever", async () => {
    const rule: RateLimitRule = { name: "test-expiry", capacity: 10, refillPerSecond: 2 };

    await consumeRateLimit(rule, "tenant-1");

    // capacity / refill = 5s: after that the bucket would be full anyway.
    const ttlMs = await getTestRedis().pttl("ratelimit:test-expiry:tenant-1");
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(5000);
  });

  it("fails open when Redis is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const down = unreachableRedis();
    vi.mocked(getCacheRedis).mockReturnValue(down);

    try {
      const started = Date.now();
      const result = await consumeRateLimit(frozen(1), "tenant-1");

      expect(result.allowed).toBe(true);
      // ...and promptly: the limiter must not stall the request it guards.
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      down.disconnect();
    }
  });
});
