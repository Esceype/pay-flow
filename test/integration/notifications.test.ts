import { UnrecoverableError } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailError, sendEmail } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { buildNotification, handleNotificationJob } from "@/worker/notifications";
import { createCustomer, createInvoice, createLinkedSubscription, createTenant } from "../db";
import { notificationsQueue } from "../queues";
import { checkoutSession, stripeEvent, subscriptionInvoice, T } from "../stripe-events";
import { processEvent } from "../worker";

// The email provider is the one thing replaced here: these tests are about
// what gets sent, to whom, and how many times — not about HTTP. The client
// itself is unit-tested in src/lib/email.test.ts.
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendEmail: vi.fn(),
}));
const send = vi.mocked(sendEmail);

beforeEach(() => {
  send.mockReset().mockResolvedValue({ status: "sent", id: "email_1" });
});

// A one-time invoice, paid: the event is processed and has recorded a
// Transaction.
async function paidInvoice() {
  const tenant = await createTenant();
  const customer = await createCustomer(tenant.id);
  const invoice = await createInvoice(customer, { amountDue: 2000 });
  const event = stripeEvent(
    "checkout.session.completed",
    checkoutSession({ id: invoice.stripeCheckoutSessionId!, amountTotal: 2000 }),
    { account: tenant.stripeAccountId }
  );
  const processed = await processEvent(event);
  return { tenant, customer, invoice, event, processed };
}

async function failedSubscriptionPayment() {
  const tenant = await createTenant();
  const customer = await createCustomer(tenant.id);
  const subscription = await createLinkedSubscription(customer, { amount: 2900 });
  const event = stripeEvent(
    "invoice.payment_failed",
    subscriptionInvoice({
      id: "in_test_failed",
      stripeSubscriptionId: subscription.stripeSubscriptionId!,
      amountDue: 2900,
      attemptCount: 2,
      nextPaymentAttempt: T + 3 * 86_400,
    }),
    { account: tenant.stripeAccountId }
  );
  const processed = await processEvent(event);
  return { tenant, customer, subscription, event, processed };
}

describe("which events the tenant is told about", () => {
  it("asks for a notification after a payment event", async () => {
    const { processed } = await paidInvoice();

    expect(notificationsQueue.add).toHaveBeenCalledExactlyOnceWith("checkout.session.completed", {
      webhookEventId: processed.id,
    });
  });

  it("asks for one after a failed subscription payment, which changes nothing else", async () => {
    const { processed } = await failedSubscriptionPayment();

    // No processor: the subscription's PAST_DUE comes from
    // customer.subscription.updated. The event is still acknowledged.
    expect(processed.status).toBe("PROCESSED");
    expect(notificationsQueue.add).toHaveBeenCalledExactlyOnceWith("invoice.payment_failed", {
      webhookEventId: processed.id,
    });
  });

  it("doesn't ask for one after events nobody needs an email about", async () => {
    const tenant = await createTenant();

    await processEvent(
      stripeEvent("account.updated", { id: "acct_x", object: "account" }, { account: "acct_x" })
    );
    await processEvent(
      stripeEvent("customer.created", { id: "cus_1" }, { account: tenant.stripeAccountId })
    );

    expect(notificationsQueue.add).not.toHaveBeenCalled();
  });
});

describe("buildNotification", () => {
  it("announces a paid invoice to the tenant", async () => {
    const { tenant, customer, processed } = await paidInvoice();

    const draft = await buildNotification(processed);

    expect(draft).toMatchObject({
      kind: "payment_received",
      userId: tenant.id,
      recipient: tenant.email,
      subject: `Payment received: 20.00 USD from ${customer.email}`,
    });
    expect(draft!.text).toContain("an invoice payment of 20.00 USD");
  });

  it("announces a subscription payment", async () => {
    const tenant = await createTenant();
    const customer = await createCustomer(tenant.id);
    const subscription = await createLinkedSubscription(customer, { amount: 2900 });
    const processed = await processEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoice({
          id: "in_test_paid",
          stripeSubscriptionId: subscription.stripeSubscriptionId!,
          amountPaid: 2900,
        }),
        { account: tenant.stripeAccountId }
      )
    );

    const draft = await buildNotification(processed);

    expect(draft).toMatchObject({
      kind: "payment_received",
      recipient: tenant.email,
      subject: `Payment received: 29.00 USD from ${customer.email}`,
    });
    expect(draft!.text).toContain("a subscription payment of 29.00 USD");
  });

  it("stays silent for a 'paid' event that didn't record the payment", async () => {
    // Two events can say the same session was paid; only the first one
    // writes the Transaction, so only the first one is news.
    const { tenant, invoice } = await paidInvoice();
    const second = await processEvent(
      stripeEvent(
        "checkout.session.async_payment_succeeded",
        checkoutSession({ id: invoice.stripeCheckoutSessionId! }),
        { account: tenant.stripeAccountId }
      )
    );

    expect(await buildNotification(second)).toBeNull();
  });

  it("stays silent when checkout completed but nothing has been paid yet", async () => {
    const tenant = await createTenant();
    const customer = await createCustomer(tenant.id);
    const invoice = await createInvoice(customer);
    const processed = await processEvent(
      stripeEvent(
        "checkout.session.completed",
        checkoutSession({ id: invoice.stripeCheckoutSessionId!, paymentStatus: "unpaid" }),
        { account: tenant.stripeAccountId }
      )
    );

    expect(await buildNotification(processed)).toBeNull();
  });

  it("reports a failed subscription payment, with what happens next", async () => {
    const { tenant, customer, processed } = await failedSubscriptionPayment();

    const draft = await buildNotification(processed);

    expect(draft).toMatchObject({
      kind: "subscription_payment_failed",
      userId: tenant.id,
      recipient: tenant.email,
      subject: `Payment failed: 29.00 USD from ${customer.email}`,
    });
    expect(draft!.text).toContain("(attempt 2)");
    expect(draft!.text).toContain(
      `Stripe will retry on ${new Date((T + 3 * 86_400) * 1000).toISOString().slice(0, 10)}`
    );
  });

  it("stays silent about a failed payment on a subscription PayFlow doesn't manage", async () => {
    const tenant = await createTenant();
    const processed = await processEvent(
      stripeEvent(
        "invoice.payment_failed",
        subscriptionInvoice({ id: "in_test_foreign", stripeSubscriptionId: "sub_test_foreign" }),
        { account: tenant.stripeAccountId }
      )
    );

    expect(await buildNotification(processed)).toBeNull();
  });

  it("never tells one tenant about another tenant's subscription", async () => {
    const { subscription } = await failedSubscriptionPayment();
    const otherTenant = await createTenant();
    const processed = await processEvent(
      stripeEvent(
        "invoice.payment_failed",
        subscriptionInvoice({
          id: "in_test_cross_tenant",
          stripeSubscriptionId: subscription.stripeSubscriptionId!,
        }),
        { account: otherTenant.stripeAccountId }
      )
    );

    expect(await buildNotification(processed)).toBeNull();
  });
});

describe("handleNotificationJob", () => {
  const notifications = () => prisma.notification.findMany();

  it("records the notification and sends it, keyed by the event", async () => {
    const { tenant, customer, event, processed } = await paidInvoice();

    await handleNotificationJob(processed.id);

    const key = `payment_received:${event.id}`;
    expect(send).toHaveBeenCalledExactlyOnceWith(
      {
        to: tenant.email,
        subject: `Payment received: 20.00 USD from ${customer.email}`,
        text: expect.stringContaining("20.00 USD"),
      },
      // The provider's idempotency key.
      key
    );
    expect(await notifications()).toMatchObject([
      {
        userId: tenant.id,
        kind: "payment_received",
        dedupeKey: key,
        recipient: tenant.email,
        status: "SENT",
        providerMessageId: "email_1",
        sentAt: expect.any(Date),
      },
    ]);
  });

  it("sends once however many times the job runs", async () => {
    const { processed } = await paidInvoice();

    await handleNotificationJob(processed.id);
    await handleNotificationJob(processed.id);
    await handleNotificationJob(processed.id);

    expect(send).toHaveBeenCalledOnce();
    expect(await notifications()).toHaveLength(1);
  });

  it("re-sends under the same key after a crash between sending and recording it", async () => {
    const { event, processed } = await paidInvoice();
    // First run: the provider accepted the email, then the worker died
    // before marking the row.
    await handleNotificationJob(processed.id);
    await prisma.notification.updateMany({ data: { status: "PENDING", sentAt: null } });
    send.mockClear();

    await handleNotificationJob(processed.id);

    // It can't know the first send went through, so it sends again — with
    // the same idempotency key, which is what lets the provider drop it.
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      `payment_received:${event.id}`
    );
    expect(await notifications()).toMatchObject([{ status: "SENT" }]);
  });

  it("records the notification as skipped when no email provider is configured", async () => {
    const { processed } = await paidInvoice();
    send.mockResolvedValue({ status: "skipped" });

    await handleNotificationJob(processed.id);

    expect(await notifications()).toMatchObject([{ status: "SKIPPED", sentAt: null }]);
  });

  it("fails the job, keeping the notification pending, when the provider is unavailable", async () => {
    const { processed } = await paidInvoice();
    send.mockRejectedValueOnce(new EmailError("Resend responded 503", 503, false));

    await expect(handleNotificationJob(processed.id)).rejects.toThrow(EmailError);
    expect(await notifications()).toMatchObject([{ status: "PENDING" }]);

    await handleNotificationJob(processed.id); // BullMQ's retry

    expect(await notifications()).toMatchObject([{ status: "SENT" }]);
  });

  it("gives up at once on a request the provider will never accept", async () => {
    const { processed } = await paidInvoice();
    send.mockRejectedValueOnce(new EmailError("Resend responded 422: invalid `to`", 422, true));

    await expect(handleNotificationJob(processed.id)).rejects.toThrow(UnrecoverableError);
  });

  it("does nothing for an event with nothing to announce", async () => {
    const tenant = await createTenant();
    const customer = await createCustomer(tenant.id);
    const invoice = await createInvoice(customer);
    const processed = await processEvent(
      stripeEvent(
        "checkout.session.completed",
        checkoutSession({ id: invoice.stripeCheckoutSessionId!, paymentStatus: "unpaid" }),
        { account: tenant.stripeAccountId }
      )
    );

    await handleNotificationJob(processed.id);

    expect(send).not.toHaveBeenCalled();
    expect(await notifications()).toEqual([]);
  });

  it("can't do anything without the event it is about", async () => {
    await expect(handleNotificationJob("no-such-event")).rejects.toThrow(UnrecoverableError);
  });
});
