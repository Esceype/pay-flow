import { describe, expect, it } from "vitest";
import {
  AMOUNT_PATTERN,
  applicationFeeFor,
  isStripeCheckoutUrl,
  MAX_AMOUNT,
  toMinorUnits,
} from "./billing";

describe("toMinorUnits", () => {
  it("converts typed amounts to exact minor units", () => {
    expect(toMinorUnits("19.99")).toBe(1999);
    expect(toMinorUnits("19.9")).toBe(1990);
    expect(toMinorUnits("19")).toBe(1900);
    expect(toMinorUnits("0.07")).toBe(7);
  });

  it("is exact where floating-point multiplication is not", () => {
    // The reason this works on the string: these all come out one cent
    // short (or as a non-integer) when computed as amount * 100.
    expect(19.99 * 100).not.toBe(1999);
    for (const [typed, cents] of [
      ["19.99", 1999],
      ["1.15", 115],
      ["4.35", 435],
      ["8.2", 820],
      ["1005.01", 100501],
    ] as const) {
      expect(toMinorUnits(typed)).toBe(cents);
    }
  });

  it("handles the largest allowed amount", () => {
    expect(toMinorUnits("999999.99")).toBe(MAX_AMOUNT);
  });
});

describe("AMOUNT_PATTERN", () => {
  it.each(["19", "19.9", "19.99", "0.50", "1000000"])("accepts %s", (value) => {
    expect(AMOUNT_PATTERN.test(value)).toBe(true);
  });

  it.each(["", "19.999", "-5", "1e3", "19,99", ".99", "19.", "abc", " 19"])(
    "rejects %j",
    (value) => {
      expect(AMOUNT_PATTERN.test(value)).toBe(false);
    }
  );
});

describe("applicationFeeFor", () => {
  it("takes the configured basis points of the amount", () => {
    expect(applicationFeeFor(2000, 250)).toBe(50);
    expect(applicationFeeFor(10_000, 1000)).toBe(1000);
  });

  it("rounds down, never charging more than the advertised rate", () => {
    // 2.5% of 19.99 is 49.975 cents.
    expect(applicationFeeFor(1999, 250)).toBe(49);
    expect(applicationFeeFor(1, 250)).toBe(0);
  });

  it("is zero when the platform fee is disabled", () => {
    expect(applicationFeeFor(1999, 0)).toBe(0);
  });
});

describe("isStripeCheckoutUrl", () => {
  it("accepts Stripe-hosted Checkout URLs", () => {
    expect(isStripeCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_123#fid")).toBe(true);
  });

  it.each([
    ["another host", "https://evil.example/c/pay/cs_test_123"],
    ["Stripe's name in the path", "https://evil.example/checkout.stripe.com"],
    ["a lookalike subdomain", "https://checkout.stripe.com.evil.example/c/pay"],
    ["plain http", "http://checkout.stripe.com/c/pay/cs_test_123"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["not a URL", "checkout.stripe.com"],
    ["an empty string", ""],
  ])("rejects %s", (_name, value) => {
    expect(isStripeCheckoutUrl(value)).toBe(false);
  });
});
