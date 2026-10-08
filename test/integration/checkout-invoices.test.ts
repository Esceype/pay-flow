import { UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createCustomer, createInvoice, createTenant } from "../db";
import { checkoutSession, stripeEvent } from "../stripe-events";
import { processEvent } from "../worker";

async function setUpInvoice() {
  const tenant = await createTenant();
  const customer = await createCustomer(tenant.id);
  const invoice = await createInvoice(customer, { amountDue: 2000 });
  return { tenant, invoice, sessionId: invoice.stripeCheckoutSessionId! };
}

const invoiceStatus = async (id: string) =>
  (await prisma.invoice.findUniqueOrThrow({ where: { id } })).status;

const transactionsFor = (invoiceId: string) => prisma.transaction.findMany({ where: { invoiceId } });

describe("Checkout events for an invoice", () => {
  it("marks the invoice PAID and records one Transaction", async () => {
    const { tenant, invoice, sessionId } = await setUpInvoice();
    const event = stripeEvent(
      "checkout.session.completed",
      checkoutSession({ id: sessionId, amountTotal: 2000 }),
      { account: tenant.stripeAccountId }
    );

    const processed = await processEvent(event);

    expect(processed.status).toBe("PROCESSED");
    expect(await invoiceStatus(invoice.id)).toBe("PAID");
    expect(await transactionsFor(invoice.id)).toMatchObject([
      {
        userId: tenant.id,
        amount: 2000,
        currency: "usd",
        type: "checkout.session.completed",
        stripeEventId: event.id,
      },
    ]);
  });

  it("keeps the invoice PENDING while an async payment settles, then PAID once", async () => {
    const { tenant, invoice, sessionId } = await setUpInvoice();
    const account = tenant.stripeAccountId;

    await processEvent(
      stripeEvent(
        "checkout.session.completed",
        checkoutSession({ id: sessionId, paymentStatus: "unpaid" }),
        { account }
      )
    );
    expect(await invoiceStatus(invoice.id)).toBe("PENDING");
    expect(await transactionsFor(invoice.id)).toHaveLength(0);

    await processEvent(
      stripeEvent("checkout.session.async_payment_succeeded", checkoutSession({ id: sessionId }), {
        account,
      })
    );
    expect(await invoiceStatus(invoice.id)).toBe("PAID");
    expect(await transactionsFor(invoice.id)).toHaveLength(1);
  });

  it("marks the invoice FAILED when the async payment fails", async () => {
    const { tenant, invoice, sessionId } = await setUpInvoice();

    await processEvent(
      stripeEvent(
        "checkout.session.async_payment_failed",
        checkoutSession({ id: sessionId, paymentStatus: "unpaid" }),
        { account: tenant.stripeAccountId }
      )
    );

    expect(await invoiceStatus(invoice.id)).toBe("FAILED");
    expect(await transactionsFor(invoice.id)).toHaveLength(0);
  });

  it("writes exactly one Transaction when several 'paid' events race", async () => {
    const { tenant, invoice, sessionId } = await setUpInvoice();
    const account = tenant.stripeAccountId;
    // Three distinct events that each mean "this session is paid",
    // processed at the same time — as with WORKER_CONCURRENCY > 1.
    const events = [
      stripeEvent("checkout.session.completed", checkoutSession({ id: sessionId }), { account }),
      stripeEvent("checkout.session.async_payment_succeeded", checkoutSession({ id: sessionId }), {
        account,
      }),
      stripeEvent("checkout.session.async_payment_succeeded", checkoutSession({ id: sessionId }), {
        account,
      }),
    ];

    const processed = await Promise.all(events.map(processEvent));

    expect(processed.map((event) => event.status)).toEqual(["PROCESSED", "PROCESSED", "PROCESSED"]);
    expect(await invoiceStatus(invoice.id)).toBe("PAID");
    expect(await transactionsFor(invoice.id)).toHaveLength(1);
  });

  it("marks the invoice EXPIRED when its session expires", async () => {
    const { tenant, invoice, sessionId } = await setUpInvoice();

    await processEvent(
      stripeEvent(
        "checkout.session.expired",
        checkoutSession({ id: sessionId, paymentStatus: "unpaid" }),
        { account: tenant.stripeAccountId }
      )
    );

    expect(await invoiceStatus(invoice.id)).toBe("EXPIRED");
  });

  it("ignores the expiry of a session the invoice no longer points at", async () => {
    const { tenant, invoice, sessionId: oldSessionId } = await setUpInvoice();
    // The tenant already regenerated the payment link.
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { stripeCheckoutSessionId: "cs_test_replacement" },
    });

    await processEvent(
      stripeEvent(
        "checkout.session.expired",
        checkoutSession({ id: oldSessionId, paymentStatus: "unpaid" }),
        { account: tenant.stripeAccountId }
      )
    );

    expect(await invoiceStatus(invoice.id)).toBe("PENDING");
  });

  it("does not let an expiry undo a payment", async () => {
    const { tenant, invoice, sessionId } = await setUpInvoice();
    const account = tenant.stripeAccountId;

    await processEvent(
      stripeEvent("checkout.session.completed", checkoutSession({ id: sessionId }), { account })
    );
    await processEvent(
      stripeEvent("checkout.session.expired", checkoutSession({ id: sessionId }), { account })
    );

    expect(await invoiceStatus(invoice.id)).toBe("PAID");
  });

  it("acknowledges a session PayFlow didn't create", async () => {
    const tenant = await createTenant();

    const processed = await processEvent(
      stripeEvent("checkout.session.completed", checkoutSession({ id: "cs_test_not_ours" }), {
        account: tenant.stripeAccountId,
      })
    );

    expect(processed.status).toBe("PROCESSED");
    expect(await prisma.transaction.count()).toBe(0);
  });

  it("refuses an event from a tenant that doesn't own the invoice", async () => {
    const { invoice, sessionId } = await setUpInvoice();
    const otherTenant = await createTenant();

    await expect(
      processEvent(
        stripeEvent("checkout.session.completed", checkoutSession({ id: sessionId }), {
          account: otherTenant.stripeAccountId,
        })
      )
      // Unrecoverable: BullMQ skips the retries and the worker marks the
      // event FAILED — retrying can't change who owns the invoice.
    ).rejects.toThrow(UnrecoverableError);

    expect(await invoiceStatus(invoice.id)).toBe("PENDING");
    expect(await prisma.transaction.count()).toBe(0);
  });

  it("leaves subscription-mode sessions to the subscription processors", async () => {
    const { tenant, invoice, sessionId } = await setUpInvoice();

    await processEvent(
      stripeEvent(
        "checkout.session.completed",
        checkoutSession({ id: sessionId, mode: "subscription" }),
        { account: tenant.stripeAccountId }
      )
    );

    expect(await invoiceStatus(invoice.id)).toBe("PENDING");
    expect(await prisma.transaction.count()).toBe(0);
  });
});
