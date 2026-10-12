import { afterEach, describe, expect, it, vi } from "vitest";
import { addLogContext, log, withLogContext } from "./logger";

// Captures what the logger writes and parses it back, the way a log
// aggregator would.
function capture() {
  const lines: { stream: "log" | "warn" | "error"; entry: Record<string, unknown> }[] = [];
  for (const stream of ["log", "warn", "error"] as const) {
    vi.spyOn(console, stream).mockImplementation((line: string) => {
      lines.push({ stream, entry: JSON.parse(line) });
    });
  }
  return lines;
}

afterEach(() => vi.restoreAllMocks());

describe("log", () => {
  it("writes one JSON object per line with level, time and message", () => {
    const lines = capture();

    log.info("webhook event processed", { durationMs: 12 });

    expect(lines).toHaveLength(1);
    expect(lines[0].entry).toEqual({
      level: "info",
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      msg: "webhook event processed",
      durationMs: 12,
    });
  });

  it("sends each level to the matching console stream", () => {
    const lines = capture();

    log.info("a");
    log.warn("b");
    log.error("c");

    expect(lines.map((line) => [line.stream, line.entry.level])).toEqual([
      ["log", "info"],
      ["warn", "warn"],
      ["error", "error"],
    ]);
  });

  it("serializes an error passed as `err`, including provider fields", () => {
    const lines = capture();
    const err = Object.assign(new Error("No such customer"), {
      type: "StripeInvalidRequestError",
      code: "resource_missing",
      statusCode: 404,
    });

    log.error("stripe call failed", { err });

    expect(lines[0].entry.err).toEqual({
      name: "Error",
      message: "No such customer",
      type: "StripeInvalidRequestError",
      code: "resource_missing",
      statusCode: 404,
      stack: expect.stringContaining("No such customer"),
    });
  });

  it("logs a thrown non-Error as it is", () => {
    const lines = capture();

    log.error("something threw", { err: "just a string" });

    expect(lines[0].entry.err).toBe("just a string");
  });
});

describe("withLogContext", () => {
  it("adds its fields to every line logged inside it", () => {
    const lines = capture();

    withLogContext({ stripeEventId: "evt_1", userId: "user_1" }, () => {
      log.info("first");
      log.warn("second", { attempt: 2 });
    });

    expect(lines.map((line) => line.entry)).toEqual([
      expect.objectContaining({ msg: "first", stripeEventId: "evt_1", userId: "user_1" }),
      expect.objectContaining({ msg: "second", stripeEventId: "evt_1", userId: "user_1", attempt: 2 }),
    ]);
  });

  it("follows the code across awaits and into functions it calls", async () => {
    const lines = capture();
    // Stands in for a processor several calls down, which is never handed
    // the event id.
    const deepInsideAProcessor = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.info("from deep inside");
    };

    await withLogContext({ stripeEventId: "evt_1" }, async () => {
      await deepInsideAProcessor();
    });

    expect(lines[0].entry).toMatchObject({ msg: "from deep inside", stripeEventId: "evt_1" });
  });

  it("keeps concurrent contexts apart", async () => {
    const lines = capture();
    const job = (stripeEventId: string, delayMs: number) =>
      withLogContext({ stripeEventId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        log.info("done");
      });

    // Two jobs interleaving in one process, as with WORKER_CONCURRENCY > 1.
    await Promise.all([job("evt_slow", 20), job("evt_fast", 1)]);

    expect(lines.map((line) => line.entry.stripeEventId)).toEqual(["evt_fast", "evt_slow"]);
  });

  it("nests: inner fields are added for the inner call only", () => {
    const lines = capture();

    withLogContext({ stripeEventId: "evt_1", step: "outer" }, () => {
      withLogContext({ step: "inner", subscriptionId: "sub_1" }, () => log.info("inside"));
      log.info("back outside");
    });

    expect(lines[0].entry).toMatchObject({
      stripeEventId: "evt_1",
      step: "inner",
      subscriptionId: "sub_1",
    });
    expect(lines[1].entry).toMatchObject({ stripeEventId: "evt_1", step: "outer" });
    expect(lines[1].entry).not.toHaveProperty("subscriptionId");
  });

  it("lets a line's own fields override the context's", () => {
    const lines = capture();

    withLogContext({ userId: "from_context" }, () => log.info("x", { userId: "from_call" }));

    expect(lines[0].entry.userId).toBe("from_call");
  });

  it("returns what the wrapped function returns", async () => {
    expect(withLogContext({}, () => 42)).toBe(42);
    await expect(withLogContext({}, async () => "done")).resolves.toBe("done");
  });
});

describe("addLogContext", () => {
  it("adds fields to the current context from that point on", () => {
    const lines = capture();

    withLogContext({ stripeEventId: "evt_1" }, () => {
      log.info("before the tenant is known");
      addLogContext({ userId: "user_1" });
      log.info("after");
    });

    expect(lines[0].entry).not.toHaveProperty("userId");
    expect(lines[1].entry).toMatchObject({ stripeEventId: "evt_1", userId: "user_1" });
  });

  it("does nothing outside a context, and nothing leaks out of one", () => {
    const lines = capture();

    addLogContext({ userId: "user_1" });
    withLogContext({ stripeEventId: "evt_1" }, () => addLogContext({ userId: "user_2" }));
    log.info("outside");

    expect(lines[0].entry).toEqual({
      level: "info",
      time: expect.any(String),
      msg: "outside",
    });
  });
});
