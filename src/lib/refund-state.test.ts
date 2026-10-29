import { describe, expect, it } from "vitest";
import {
  canTransition,
  ledgerEffect,
  mapStripeRefundStatus,
  refundableAmount,
} from "./refund-state";

const STATUSES = ["PENDING", "SUCCEEDED", "FAILED", "CANCELED"] as const;

describe("refund transitions", () => {
  it.each([
    ["PENDING", "SUCCEEDED"],
    ["PENDING", "FAILED"],
    ["PENDING", "CANCELED"],
    ["SUCCEEDED", "FAILED"],
  ] as const)("allow %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it("never moves a refund backwards or out of a final state", () => {
    const allowed = new Set(["PENDING>SUCCEEDED", "PENDING>FAILED", "PENDING>CANCELED", "SUCCEEDED>FAILED"]);
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it("has no cycles, which is what makes timestamps unnecessary", () => {
    // Follow every allowed edge: no state may lead back to itself.
    const next = (from: string) => STATUSES.filter((to) => canTransition(from as never, to));
    const reachesItself = (start: string) => {
      const seen = new Set<string>();
      const stack = next(start);
      while (stack.length) {
        const state = stack.pop()!;
        if (state === start) return true;
        if (!seen.has(state)) {
          seen.add(state);
          stack.push(...next(state));
        }
      }
      return false;
    };
    for (const state of STATUSES) expect(reachesItself(state), state).toBe(false);
  });
});

describe("ledgerEffect", () => {
  it("debits when a refund goes through", () => {
    expect(ledgerEffect("PENDING", "SUCCEEDED")).toBe("debit");
  });

  it("credits the money back when a refund fails after going through", () => {
    expect(ledgerEffect("SUCCEEDED", "FAILED")).toBe("credit");
  });

  it.each([
    ["PENDING", "FAILED"],
    ["PENDING", "CANCELED"],
  ] as const)("moves no money for %s -> %s", (from, to) => {
    expect(ledgerEffect(from, to)).toBeNull();
  });
});

describe("mapStripeRefundStatus", () => {
  it.each([
    ["pending", "PENDING"],
    ["requires_action", "PENDING"],
    ["succeeded", "SUCCEEDED"],
    ["failed", "FAILED"],
    ["canceled", "CANCELED"],
  ])("maps %s to %s", (stripeStatus, expected) => {
    expect(mapStripeRefundStatus(stripeStatus)).toBe(expected);
  });

  it("returns null for an unknown or missing status rather than guessing", () => {
    expect(mapStripeRefundStatus("some_future_status")).toBeNull();
    expect(mapStripeRefundStatus(null)).toBeNull();
  });
});

describe("refundableAmount", () => {
  it("is the whole payment before any refund", () => {
    expect(refundableAmount(2000, [])).toBe(2000);
  });

  it("subtracts succeeded refunds and pending ones alike", () => {
    expect(
      refundableAmount(2000, [
        { amount: 500, status: "SUCCEEDED" },
        { amount: 300, status: "PENDING" },
      ])
    ).toBe(1200);
  });

  it("gives back what failed or canceled refunds had set aside", () => {
    expect(
      refundableAmount(2000, [
        { amount: 500, status: "FAILED" },
        { amount: 700, status: "CANCELED" },
      ])
    ).toBe(2000);
  });

  it("never goes below zero", () => {
    expect(refundableAmount(1000, [{ amount: 1500, status: "SUCCEEDED" }])).toBe(0);
  });
});
