import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/webhooks/stripe-connect/route";
import { prisma } from "@/lib/prisma";
import { handleWebhookEvent } from "@/worker/handle-webhook-event";
import { relayStuckWebhookEvents, STALE_AFTER_MS } from "@/worker/relay";
import { createCustomer, createInvoice, createTenant } from "../db";
import { fakeJob, webhookEventsQueue } from "../queues";
import { checkoutSession, storeEvent, stripeEvent } from "../stripe-events";

const { add, getJob } = webhookEventsQueue;

// A stored event, aged past the relay's threshold unless told otherwise.
async function storedEvent(
  options: { status?: "RECEIVED" | "PROCESSING" | "PROCESSED" | "FAILED"; ageMs?: number } = {}
) {
  const tenant = await createTenant();
  const stored = await storeEvent(
    stripeEvent("customer.created", { id: "cus_1" }, { account: tenant.stripeAccountId })
  );
  return prisma.webhookEvent.update({
    where: { id: stored.id },
    data: {
      status: options.status ?? "RECEIVED",
      receivedAt: new Date(Date.now() - (options.ageMs ?? STALE_AFTER_MS + 60_000)),
    },
  });
}

const statusOf = async (id: string) =>
  (await prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).status;

describe("relayStuckWebhookEvents", () => {
  it("enqueues a stored event that has no job", async () => {
    const event = await storedEvent();

    const result = await relayStuckWebhookEvents();

    expect(result).toEqual({ requeued: 1, markedFailed: 0, inFlight: 0 });
    // Same jobId as the webhook route uses, so the two can never produce
    // two jobs for one event.
    expect(add).toHaveBeenCalledExactlyOnceWith(
      "customer.created",
      { webhookEventId: event.id },
      { jobId: event.id }
    );
  });

  it("does the same for an event stuck in PROCESSING", async () => {
    const event = await storedEvent({ status: "PROCESSING" });

    await relayStuckWebhookEvents();

    expect(add).toHaveBeenCalledExactlyOnceWith(
      "customer.created",
      { webhookEventId: event.id },
      { jobId: event.id }
    );
  });

  it("leaves a recently received event alone", async () => {
    // Its job may simply not have been picked up yet.
    await storedEvent({ ageMs: 10_000 });

    const result = await relayStuckWebhookEvents();

    expect(result).toEqual({ requeued: 0, markedFailed: 0, inFlight: 0 });
    expect(getJob).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("ignores events that are finished, one way or the other", async () => {
    await storedEvent({ status: "PROCESSED" });
    await storedEvent({ status: "FAILED" });

    await relayStuckWebhookEvents();

    expect(getJob).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it.each(["waiting", "active", "delayed"] as const)(
    "leaves an event whose job is %s",
    async (state) => {
      const event = await storedEvent({ status: "PROCESSING" });
      getJob.mockResolvedValue(fakeJob(state));

      const result = await relayStuckWebhookEvents();

      expect(result).toEqual({ requeued: 0, markedFailed: 0, inFlight: 1 });
      expect(add).not.toHaveBeenCalled();
      expect(await statusOf(event.id)).toBe("PROCESSING");
    }
  );

  it("marks an event FAILED when its job failed for good but nobody recorded it", async () => {
    // The worker died (or the database was down) right when BullMQ gave up.
    const event = await storedEvent({ status: "PROCESSING" });
    getJob.mockResolvedValue(fakeJob("failed", "Stripe API timed out"));

    const result = await relayStuckWebhookEvents();

    expect(result).toEqual({ requeued: 0, markedFailed: 1, inFlight: 0 });
    expect(add).not.toHaveBeenCalled();
    const reloaded = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(reloaded).toMatchObject({
      status: "FAILED",
      lastError: "Error: Stripe API timed out",
      failedAt: expect.any(Date),
    });
  });

  it("re-runs an event whose job claims to be complete while the event isn't", async () => {
    const event = await storedEvent({ status: "PROCESSING" });
    const job = fakeJob("completed");
    getJob.mockResolvedValue(job);

    const result = await relayStuckWebhookEvents();

    expect(result.requeued).toBe(1);
    // The stale job has to go first: add() is a no-op while its id exists.
    expect(job.remove).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledOnce();
    expect(await statusOf(event.id)).toBe("PROCESSING");
  });

  it("works through a batch oldest first", async () => {
    const newer = await storedEvent({ ageMs: STALE_AFTER_MS + 60_000 });
    const older = await storedEvent({ ageMs: STALE_AFTER_MS + 3_600_000 });

    await relayStuckWebhookEvents();

    expect(add.mock.calls.map(([, data]) => data.webhookEventId)).toEqual([older.id, newer.id]);
  });
});

describe("a webhook that arrives while Redis is down", () => {
  const signer = new Stripe("sk_test_signer_only");

  it("is accepted, then delivered by the relay and processed exactly once", async () => {
    const tenant = await createTenant();
    const customer = await createCustomer(tenant.id);
    const invoice = await createInvoice(customer, { amountDue: 2000 });
    const event = stripeEvent(
      "checkout.session.completed",
      checkoutSession({ id: invoice.stripeCheckoutSessionId!, amountTotal: 2000 }),
      { account: tenant.stripeAccountId }
    );
    const payload = JSON.stringify(event);

    // 1. Stripe delivers; the enqueue fails; Stripe is told 200 regardless.
    add.mockRejectedValueOnce(new Error("Redis is down"));
    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe-connect", {
        method: "POST",
        headers: {
          "stripe-signature": signer.webhooks.generateTestHeaderString({
            payload,
            secret: process.env.STRIPE_CONNECT_WEBHOOK_SECRET!,
          }),
        },
        body: payload,
      })
    );
    expect(response.status).toBe(200);
    const stored = await prisma.webhookEvent.findUniqueOrThrow({
      where: { stripeEventId: event.id },
    });
    add.mockClear();

    // 2. Redis is back. Nothing has a job for the event; the relay finds
    //    the row once it is old enough.
    expect((await relayStuckWebhookEvents()).requeued).toBe(0); // too fresh
    const later = new Date(Date.now() + STALE_AFTER_MS + 1000);
    expect((await relayStuckWebhookEvents(later)).requeued).toBe(1);
    expect(add).toHaveBeenCalledExactlyOnceWith(
      "checkout.session.completed",
      { webhookEventId: stored.id },
      { jobId: stored.id }
    );

    // 3. The worker runs the job the relay created.
    await handleWebhookEvent(stored.id);

    expect(await statusOf(stored.id)).toBe("PROCESSED");
    const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(paid.status).toBe("PAID");
    expect(await prisma.transaction.count({ where: { invoiceId: invoice.id } })).toBe(1);

    // 4. A relay run after that has nothing left to do.
    add.mockClear();
    expect(await relayStuckWebhookEvents(later)).toEqual({
      requeued: 0,
      markedFailed: 0,
      inFlight: 0,
    });
  });
});
