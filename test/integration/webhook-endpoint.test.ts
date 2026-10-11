import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/webhooks/stripe-connect/route";
import { prisma } from "@/lib/prisma";
import { handleWebhookEvent } from "@/worker/handle-webhook-event";
import { createCustomer, createInvoice, createTenant } from "../db";
import { webhookEventsQueue } from "../queues";
import { checkoutSession, stripeEvent, type TestStripeEvent } from "../stripe-events";

// The queue is a fake (test/queues.ts): these tests are about what the
// endpoint records and asks to have processed, and the fake lets them see
// exactly that (and simulate Redis being down). Jobs are then run through
// the worker's real handler.
const { add } = webhookEventsQueue;

const signer = new Stripe("sk_test_signer_only");

function deliver(event: TestStripeEvent, secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET!) {
  const payload = JSON.stringify(event);
  const signature = signer.webhooks.generateTestHeaderString({ payload, secret });
  return POST(
    new Request("http://localhost:3000/api/webhooks/stripe-connect", {
      method: "POST",
      headers: { "stripe-signature": signature },
      body: payload,
    })
  );
}

// Runs every job the endpoint enqueued, as the BullMQ worker would.
async function runEnqueuedJobs() {
  for (const [, data] of add.mock.calls as [string, { webhookEventId: string }][]) {
    await handleWebhookEvent(data.webhookEventId);
  }
}

describe("POST /api/webhooks/stripe-connect", () => {
  it("stores the event against its tenant and enqueues it by row id", async () => {
    const tenant = await createTenant();
    const event = stripeEvent("customer.created", { id: "cus_1" }, { account: tenant.stripeAccountId });

    const response = await deliver(event);

    expect(response.status).toBe(200);
    const stored = await prisma.webhookEvent.findUniqueOrThrow({
      where: { stripeEventId: event.id },
    });
    expect(stored).toMatchObject({
      type: "customer.created",
      stripeAccountId: tenant.stripeAccountId,
      userId: tenant.id,
      status: "RECEIVED",
    });
    // jobId = row id is what makes the enqueue idempotent (ADR-001), and the
    // job carries only the id — the payload stays in Postgres.
    expect(add).toHaveBeenCalledExactlyOnceWith(
      "customer.created",
      { webhookEventId: stored.id },
      { jobId: stored.id }
    );
  });

  it("rejects a payload that wasn't signed with the endpoint secret", async () => {
    const tenant = await createTenant();
    const event = stripeEvent("customer.created", { id: "cus_1" }, { account: tenant.stripeAccountId });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await deliver(event, "whsec_some_other_secret");

    expect(response.status).toBe(400);
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(add).not.toHaveBeenCalled();
  });

  it("rejects a request without a signature header", async () => {
    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe-connect", { method: "POST", body: "{}" })
    );

    expect(response.status).toBe(400);
    expect(await prisma.webhookEvent.count()).toBe(0);
  });

  it("keeps an event from an account it doesn't recognize, without a tenant", async () => {
    const event = stripeEvent("customer.created", { id: "cus_1" }, { account: "acct_unknown" });

    const response = await deliver(event);

    expect(response.status).toBe(200);
    const stored = await prisma.webhookEvent.findUniqueOrThrow({
      where: { stripeEventId: event.id },
    });
    expect(stored).toMatchObject({ stripeAccountId: "acct_unknown", userId: null });
  });

  it("records a duplicate delivery once and reuses the same job id", async () => {
    const tenant = await createTenant();
    const event = stripeEvent("customer.created", { id: "cus_1" }, { account: tenant.stripeAccountId });

    const first = await deliver(event);
    const second = await deliver(event);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await prisma.webhookEvent.count()).toBe(1);
    // Not yet processed, so it is enqueued again — with the same jobId,
    // which BullMQ collapses into the job that already exists.
    const jobIds = add.mock.calls.map(([, , options]) => options.jobId);
    expect(jobIds).toHaveLength(2);
    expect(new Set(jobIds).size).toBe(1);
  });

  it("acknowledges a duplicate of an already-processed event without enqueueing", async () => {
    const tenant = await createTenant();
    const event = stripeEvent("customer.created", { id: "cus_1" }, { account: tenant.stripeAccountId });
    await deliver(event);
    await runEnqueuedJobs();
    add.mockClear();

    const response = await deliver(event);

    expect(response.status).toBe(200);
    expect(add).not.toHaveBeenCalled();
  });

  it("answers non-2xx when the enqueue fails, and recovers on Stripe's retry", async () => {
    const tenant = await createTenant();
    const event = stripeEvent("customer.created", { id: "cus_1" }, { account: tenant.stripeAccountId });
    vi.spyOn(console, "error").mockImplementation(() => {});
    add.mockRejectedValueOnce(new Error("Redis is down"));

    const failed = await deliver(event);

    // The row is durable even though nothing was queued; the non-2xx makes
    // Stripe redeliver, which is the recovery path (ADR-001).
    expect(failed.status).toBe(500);
    expect(await prisma.webhookEvent.count()).toBe(1);

    const retried = await deliver(event);

    expect(retried.status).toBe(200);
    expect(await prisma.webhookEvent.count()).toBe(1);
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("does not double-process a payment event that is delivered twice", async () => {
    const tenant = await createTenant();
    const customer = await createCustomer(tenant.id);
    const invoice = await createInvoice(customer, { amountDue: 2000 });
    const event = stripeEvent(
      "checkout.session.completed",
      checkoutSession({ id: invoice.stripeCheckoutSessionId!, amountTotal: 2000 }),
      { account: tenant.stripeAccountId }
    );

    await deliver(event);
    await deliver(event);
    // Worst case: the queue's jobId dedup didn't collapse them and the
    // worker runs the job for the same event twice.
    await runEnqueuedJobs();

    expect(add).toHaveBeenCalledTimes(2);
    const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(paid.status).toBe("PAID");
    const transactions = await prisma.transaction.findMany({ where: { invoiceId: invoice.id } });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({ amount: 2000, userId: tenant.id });
  });
});
