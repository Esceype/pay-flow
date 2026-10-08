import { describe, expect, it } from "vitest";
import { checkoutOutcome } from "./checkout-session";

describe("checkoutOutcome", () => {
  it("marks a completed, paid session as PAID", () => {
    expect(checkoutOutcome("checkout.session.completed", "paid")).toBe("PAID");
  });

  it("treats a completed session with nothing to pay as PAID", () => {
    expect(checkoutOutcome("checkout.session.completed", "no_payment_required")).toBe("PAID");
  });

  it("does not mark a completed session PAID while an async payment is settling", () => {
    // SEPA, bank debits, ...: checkout completes long before the money does.
    expect(checkoutOutcome("checkout.session.completed", "unpaid")).toBe(
      "AWAITING_ASYNC_PAYMENT"
    );
  });

  it("resolves an async payment either way", () => {
    expect(checkoutOutcome("checkout.session.async_payment_succeeded", "paid")).toBe("PAID");
    expect(checkoutOutcome("checkout.session.async_payment_failed", "unpaid")).toBe("FAILED");
  });

  it("marks an expired session EXPIRED", () => {
    expect(checkoutOutcome("checkout.session.expired", "unpaid")).toBe("EXPIRED");
  });
});
