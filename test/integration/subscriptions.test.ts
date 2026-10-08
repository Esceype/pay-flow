import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { handleWebhookEvent } from "@/worker/handle-webhook-event";
import { processSubscriptionInvoicePaid } from "@/worker/processors/subscription";
import { createCustomer, createSubscription, createTenant } from "../db";
import {
  at,
  storeEvent,
  stripeEvent,
  stripeSubscription,
  subscriptionInvoice,
  T,
} from "../stripe-events";
import { processEvent } from "../worker";

const STRIPE_ID = "sub_test_1";

// A subscription as the dashboard leaves it: our row exists, the customer
// hasn't checked out, Stripe doesn't know it yet.
async function setUpSubscription() {
  const tenant = await createTenant();
  const customer = await createCustomer(tenant.id);
  const subscription = await createSubscription(customer);
  const account = tenant.stripeAccountId;

  // Lifecycle events for the Stripe subscription that Checkout created
  // from our row (its id travels in the metadata).
  const lifecycle = (
    type: "created" | "updated" | "deleted",
    status: string,
    created: number,
    extra: Partial<Parameters<typeof stripeSubscription>[0]> = {}
  ) =>
    stripeEvent(
      `customer.subscription.${type}`,
      stripeSubscription({
        id: STRIPE_ID,
        status,
        payflowSubscriptionId: subscription.id,
        ...extra,
      }),
      { account, created }
    );

  return { tenant, customer, subscription, account, lifecycle };
}

const reload = (id: string) => prisma.subscription.findUniqueOrThrow({ where: { id } });

describe("subscription lifecycle events", () => {
  it("links the row to the Stripe subscription on the first event and mirrors its state", async () => {
    const { subscription, lifecycle } = await setUpSubscription();

    await processEvent(lifecycle("created", "incomplete", T, { periodEnd: T + 2_592_000 }));

    expect(await reload(subscription.id)).toMatchObject({
      stripeSubscriptionId: STRIPE_ID,
      status: "INCOMPLETE",
      currentPeriodEnd: at(T + 2_592_000),
      lastEventAt: at(T),
    });
  });

  it("applies events that arrive in order", async () => {
    const { subscription, lifecycle } = await setUpSubscription();

    await processEvent(lifecycle("created", "incomplete", T));
    await processEvent(lifecycle("updated", "active", T + 5));
    await processEvent(lifecycle("updated", "past_due", T + 60));

    expect(await reload(subscription.id)).toMatchObject({
      status: "PAST_DUE",
      lastEventAt: at(T + 60),
    });
  });

  it("applies only the newer of two events processed out of order", async () => {
    const { subscription, lifecycle } = await setUpSubscription();

    // `updated` (T+5) overtakes `created` (T) in the queue.
    await processEvent(lifecycle("updated", "active", T + 5));
    const stale = await processEvent(lifecycle("created", "incomplete", T));

    // The stale event is acknowledged — discarding it is its correct
    // outcome, not a failure — and changes nothing.
    expect(stale.status).toBe("PROCESSED");
    expect(await reload(subscription.id)).toMatchObject({
      status: "ACTIVE",
      lastEventAt: at(T + 5),
    });
  });

  it("does not resurrect a canceled subscription when an older update arrives late", async () => {
    const { subscription, lifecycle } = await setUpSubscription();

    await processEvent(lifecycle("created", "active", T));
    await processEvent(lifecycle("deleted", "canceled", T + 10, { canceledAt: T + 10 }));
    await processEvent(lifecycle("updated", "active", T + 5));

    expect(await reload(subscription.id)).toMatchObject({
      status: "CANCELED",
      canceledAt: at(T + 10),
    });
  });

  it("treats CANCELED as final even against an event with a later timestamp", async () => {
    const { subscription, lifecycle } = await setUpSubscription();

    await processEvent(lifecycle("deleted", "canceled", T + 10));
    await processEvent(lifecycle("updated", "active", T + 20));

    expect((await reload(subscription.id)).status).toBe("CANCELED");
  });

  it("applies a cancellation even if it is older than the last applied event", async () => {
    const { subscription, lifecycle } = await setUpSubscription();

    // Not an order Stripe produces, but the rule is unconditional: a
    // terminal state is the final truth whenever it shows up.
    await processEvent(lifecycle("updated", "active", T + 20));
    await processEvent(lifecycle("deleted", "canceled", T + 10));

    expect((await reload(subscription.id)).status).toBe("CANCELED");
  });

  it("converges on the right state when events are processed concurrently", async () => {
    // Several rounds, since the interleaving differs from run to run.
    for (let round = 0; round < 5; round++) {
      const tenant = await createTenant();
      const customer = await createCustomer(tenant.id);
      const subscription = await createSubscription(customer);
      const stripeId = `sub_test_concurrent_${round}`;
      const event = (type: string, status: string, created: number) =>
        stripeEvent(
          `customer.subscription.${type}`,
          stripeSubscription({ id: stripeId, status, payflowSubscriptionId: subscription.id }),
          { account: tenant.stripeAccountId, created }
        );

      await Promise.all(
        [
          event("updated", "past_due", T + 20),
          event("created", "incomplete", T),
          event("updated", "active", T + 5),
        ].map(processEvent)
      );

      expect(await reload(subscription.id)).toMatchObject({
        stripeSubscriptionId: stripeId,
        status: "PAST_DUE",
        lastEventAt: at(T + 20),
      });
    }
  });

  it("re-reads the subscription from Stripe when two events share a timestamp", async () => {
    const { subscription, account, lifecycle } = await setUpSubscription();
    // What Stripe would answer: the subscription is active by now.
    const retrieve = vi
      .spyOn(stripe.subscriptions, "retrieve")
      .mockResolvedValue(stripeSubscription({ id: STRIPE_ID, status: "active" }) as never);

    // Created incomplete and activated by its first payment within the
    // same second — an order event.created alone can't establish.
    await processEvent(lifecycle("created", "incomplete", T));
    await processEvent(lifecycle("updated", "active", T));

    expect(retrieve).toHaveBeenCalledExactlyOnceWith(STRIPE_ID, {}, { stripeAccount: account });
    expect((await reload(subscription.id)).status).toBe("ACTIVE");
  });

  it("reaches the same state when the tied events are processed the other way round", async () => {
    const { subscription, lifecycle } = await setUpSubscription();
    vi.spyOn(stripe.subscriptions, "retrieve").mockResolvedValue(
      stripeSubscription({ id: STRIPE_ID, status: "active" }) as never
    );

    await processEvent(lifecycle("updated", "active", T));
    await processEvent(lifecycle("created", "incomplete", T));

    expect((await reload(subscription.id)).status).toBe("ACTIVE");
  });

  it("re-syncs the price when it changes in Stripe", async () => {
    const { subscription, lifecycle } = await setUpSubscription();

    await processEvent(lifecycle("created", "active", T));
    await processEvent(lifecycle("updated", "active", T + 5, { unitAmount: 4900, interval: "year" }));

    expect(await reload(subscription.id)).toMatchObject({ amount: 4900, interval: "YEAR" });
  });

  it("acknowledges a subscription PayFlow didn't create", async () => {
    const tenant = await createTenant();

    const processed = await processEvent(
      stripeEvent(
        "customer.subscription.created",
        stripeSubscription({ id: "sub_test_foreign", status: "active" }),
        { account: tenant.stripeAccountId }
      )
    );

    expect(processed.status).toBe("PROCESSED");
    expect(await prisma.subscription.count()).toBe(0);
  });

  it("does not let one tenant's metadata reach another tenant's subscription", async () => {
    const { subscription } = await setUpSubscription();
    const otherTenant = await createTenant();

    // Metadata is editable in the Stripe Dashboard: another tenant puts
    // *this* row's id on a subscription of their own.
    await processEvent(
      stripeEvent(
        "customer.subscription.created",
        stripeSubscription({
          id: "sub_test_intruder",
          status: "active",
          payflowSubscriptionId: subscription.id,
        }),
        { account: otherTenant.stripeAccountId }
      )
    );

    expect(await reload(subscription.id)).toMatchObject({
      status: "AWAITING_CHECKOUT",
      stripeSubscriptionId: null,
    });
  });

  it("refuses an event for a linked subscription from a tenant that doesn't own it", async () => {
    const { subscription, lifecycle } = await setUpSubscription();
    await processEvent(lifecycle("created", "active", T));
    const otherTenant = await createTenant();

    await expect(
      processEvent(
        stripeEvent(
          "customer.subscription.updated",
          stripeSubscription({ id: STRIPE_ID, status: "canceled" }),
          { account: otherTenant.stripeAccountId, created: T + 5 }
        )
      )
    ).rejects.toThrow(UnrecoverableError);

    expect((await reload(subscription.id)).status).toBe("ACTIVE");
  });

  it("fails loudly on a subscription status it doesn't know", async () => {
    const { subscription, lifecycle } = await setUpSubscription();

    await expect(processEvent(lifecycle("updated", "some_future_status", T))).rejects.toThrow(
      UnrecoverableError
    );

    expect((await reload(subscription.id)).status).toBe("AWAITING_CHECKOUT");
  });
});

describe("invoice.paid for a subscription", () => {
  async function setUpPaidInvoice(amountPaid = 2900) {
    const context = await setUpSubscription();
    const event = stripeEvent(
      "invoice.paid",
      subscriptionInvoice({
        id: "in_test_1",
        stripeSubscriptionId: STRIPE_ID,
        payflowSubscriptionId: context.subscription.id,
        amountPaid,
      }),
      { account: context.account, created: T + 1 }
    );
    return { ...context, event };
  }

  const transactionsFor = (subscriptionId: string) =>
    prisma.transaction.findMany({ where: { subscriptionId } });

  it("records the payment as a Transaction against the subscription", async () => {
    const { tenant, subscription, lifecycle, event } = await setUpPaidInvoice();
    await processEvent(lifecycle("created", "active", T));

    await processEvent(event);

    expect(await transactionsFor(subscription.id)).toMatchObject([
      {
        userId: tenant.id,
        invoiceId: null,
        amount: 2900,
        currency: "usd",
        type: "invoice.paid",
        stripeEventId: event.id,
      },
    ]);
    // A subscription payment never creates one of our (one-time) invoices.
    expect(await prisma.invoice.count()).toBe(0);
  });

  it("finds its subscription even when it is processed before any lifecycle event", async () => {
    const { subscription, lifecycle, event } = await setUpPaidInvoice();

    // invoice.paid wins the race against customer.subscription.created.
    await processEvent(event);

    expect(await transactionsFor(subscription.id)).toHaveLength(1);
    expect(await reload(subscription.id)).toMatchObject({
      stripeSubscriptionId: STRIPE_ID,
      // Status is the lifecycle events' job, and they haven't run yet.
      status: "AWAITING_CHECKOUT",
    });

    await processEvent(lifecycle("created", "active", T));
    expect((await reload(subscription.id)).status).toBe("ACTIVE");
  });

  it("records the payment once when the job runs again after its effects committed", async () => {
    const { subscription, event } = await setUpPaidInvoice();
    const stored = await storeEvent(event);

    // A worker that crashed after the processor's transaction committed but
    // before BullMQ recorded the job as done: the processor runs again with
    // the event exactly as it was first read.
    await processSubscriptionInvoicePaid(stored);
    await processSubscriptionInvoicePaid(stored);
    // ...and a redelivered job for it is a no-op at the handler level too.
    await handleWebhookEvent(stored.id);

    expect(await transactionsFor(subscription.id)).toHaveLength(1);
    const reloaded = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: stored.id } });
    expect(reloaded.status).toBe("PROCESSED");
  });

  it("records the payment once when the same job is processed concurrently", async () => {
    const { subscription, event } = await setUpPaidInvoice();
    const stored = await storeEvent(event);

    await Promise.all([
      processSubscriptionInvoicePaid(stored),
      processSubscriptionInvoicePaid(stored),
      processSubscriptionInvoicePaid(stored),
    ]);

    expect(await transactionsFor(subscription.id)).toHaveLength(1);
  });

  it("records nothing for an invoice that moved no money", async () => {
    const { subscription, event } = await setUpPaidInvoice(0);

    const processed = await processEvent(event);

    expect(processed.status).toBe("PROCESSED");
    expect(await transactionsFor(subscription.id)).toHaveLength(0);
  });

  it("ignores invoices that don't belong to one of our subscriptions", async () => {
    const tenant = await createTenant();
    const account = tenant.stripeAccountId;

    await processEvent(
      stripeEvent("invoice.paid", { id: "in_test_one_off", amount_paid: 500, parent: null }, { account })
    );
    await processEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoice({ id: "in_test_foreign", stripeSubscriptionId: "sub_test_foreign" }),
        { account }
      )
    );

    expect(await prisma.transaction.count()).toBe(0);
  });
});
