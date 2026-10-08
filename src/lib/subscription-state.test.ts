import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import {
  decideOrdering,
  isTerminal,
  mapStripeStatus,
  snapshotFromStripe,
  subscriptionRefOfInvoice,
  SUBSCRIPTION_METADATA_KEY,
} from "./subscription-state";

const at = (seconds: number) => new Date(seconds * 1000);
const T = 1_800_000_000;

describe("decideOrdering", () => {
  it("applies the first event a row ever sees", () => {
    expect(decideOrdering({ status: "AWAITING_CHECKOUT", lastEventAt: null }, at(T))).toBe("apply");
  });

  it("applies an event newer than the last applied one", () => {
    expect(decideOrdering({ status: "INCOMPLETE", lastEventAt: at(T) }, at(T + 1))).toBe("apply");
  });

  it("discards an event older than the last applied one", () => {
    // The out-of-order case the guard exists for: `updated` (T+5) was
    // processed first, then the earlier `created` (T) arrives.
    expect(decideOrdering({ status: "ACTIVE", lastEventAt: at(T + 5) }, at(T))).toBe("stale");
  });

  it("reports a tie for an event from the same second", () => {
    // event.created has one-second resolution: these two can't be ordered.
    expect(decideOrdering({ status: "INCOMPLETE", lastEventAt: at(T) }, at(T))).toBe("tie");
  });

  it.each(["CANCELED", "INCOMPLETE_EXPIRED"] as const)(
    "never applies anything to a %s row, however new the event",
    (status) => {
      expect(decideOrdering({ status, lastEventAt: at(T) }, at(T + 100))).toBe("terminal");
      expect(decideOrdering({ status, lastEventAt: null }, at(T))).toBe("terminal");
    }
  );
});

describe("isTerminal", () => {
  it("is true only for states Stripe never leaves", () => {
    expect(isTerminal("CANCELED")).toBe(true);
    expect(isTerminal("INCOMPLETE_EXPIRED")).toBe(true);
    for (const status of [
      "AWAITING_CHECKOUT",
      "INCOMPLETE",
      "TRIALING",
      "ACTIVE",
      "PAST_DUE",
      "UNPAID",
      "PAUSED",
    ] as const) {
      expect(isTerminal(status)).toBe(false);
    }
  });
});

describe("mapStripeStatus", () => {
  it.each([
    ["incomplete", "INCOMPLETE"],
    ["incomplete_expired", "INCOMPLETE_EXPIRED"],
    ["trialing", "TRIALING"],
    ["active", "ACTIVE"],
    ["past_due", "PAST_DUE"],
    ["unpaid", "UNPAID"],
    ["paused", "PAUSED"],
    ["canceled", "CANCELED"],
  ])("maps %s to %s", (stripeStatus, expected) => {
    expect(mapStripeStatus(stripeStatus)).toBe(expected);
  });

  it("returns null for a status it doesn't know, rather than guessing", () => {
    expect(mapStripeStatus("some_future_status")).toBeNull();
  });
});

function stripeSubscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: "sub_123",
    status: "active",
    cancel_at_period_end: false,
    canceled_at: null,
    items: {
      data: [
        {
          current_period_end: T + 2_592_000,
          quantity: 1,
          price: {
            currency: "usd",
            unit_amount: 2900,
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

describe("snapshotFromStripe", () => {
  it("mirrors status, period and price from a subscription", () => {
    expect(snapshotFromStripe(stripeSubscription())).toEqual({
      status: "ACTIVE",
      currentPeriodEnd: at(T + 2_592_000),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      amount: 2900,
      currency: "usd",
      interval: "MONTH",
      intervalCount: 1,
    });
  });

  it("multiplies the unit amount by quantity and sums items", () => {
    const price = (unit_amount: number) => ({
      currency: "eur",
      unit_amount,
      recurring: { interval: "year", interval_count: 1 },
    });
    const snapshot = snapshotFromStripe(
      stripeSubscription({
        items: {
          data: [
            { current_period_end: T, quantity: 3, price: price(1000) },
            { current_period_end: T, quantity: 1, price: price(500) },
          ],
        },
      })
    );
    expect(snapshot).toMatchObject({ amount: 3500, currency: "eur", interval: "YEAR" });
  });

  it("reads the period end from the pre-2025-03-31 payload shape", () => {
    const snapshot = snapshotFromStripe(
      stripeSubscription({ current_period_end: T + 60, items: { data: [] } })
    );
    expect(snapshot?.currentPeriodEnd).toEqual(at(T + 60));
  });

  it("leaves price fields out when the payload has no recurring price", () => {
    const snapshot = snapshotFromStripe(stripeSubscription({ items: { data: [] } }));
    expect(snapshot).toEqual({
      status: "ACTIVE",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
    });
  });

  it("carries cancellation details", () => {
    const snapshot = snapshotFromStripe(
      stripeSubscription({ status: "canceled", cancel_at_period_end: true, canceled_at: T + 9 })
    );
    expect(snapshot).toMatchObject({
      status: "CANCELED",
      cancelAtPeriodEnd: true,
      canceledAt: at(T + 9),
    });
  });

  it("returns null for an unknown status", () => {
    expect(snapshotFromStripe(stripeSubscription({ status: "some_future_status" }))).toBeNull();
  });
});

describe("subscriptionRefOfInvoice", () => {
  const metadata = { [SUBSCRIPTION_METADATA_KEY]: "our_row_id" };

  it("reads the subscription and our row id from invoice.parent", () => {
    const invoice = {
      parent: { subscription_details: { subscription: "sub_123", metadata } },
    } as unknown as Stripe.Invoice;
    expect(subscriptionRefOfInvoice(invoice)).toEqual({
      stripeSubscriptionId: "sub_123",
      payflowSubscriptionId: "our_row_id",
    });
  });

  it("accepts an expanded subscription object", () => {
    const invoice = {
      parent: { subscription_details: { subscription: { id: "sub_123" }, metadata: null } },
    } as unknown as Stripe.Invoice;
    expect(subscriptionRefOfInvoice(invoice)).toEqual({
      stripeSubscriptionId: "sub_123",
      payflowSubscriptionId: null,
    });
  });

  it("reads the pre-2025-03-31 payload shape", () => {
    const invoice = {
      subscription: "sub_123",
      subscription_details: { metadata },
    } as unknown as Stripe.Invoice;
    expect(subscriptionRefOfInvoice(invoice)).toEqual({
      stripeSubscriptionId: "sub_123",
      payflowSubscriptionId: "our_row_id",
    });
  });

  it("returns null for an invoice that isn't from a subscription", () => {
    expect(subscriptionRefOfInvoice({ parent: null } as unknown as Stripe.Invoice)).toBeNull();
    expect(
      subscriptionRefOfInvoice({
        parent: { subscription_details: null, quote_details: { quote: "qt_1" } },
      } as unknown as Stripe.Invoice)
    ).toBeNull();
  });
});
