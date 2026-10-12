import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { recordWebhookEventFailure, replayWebhookEvent } from "@/worker/dead-letter";
import { handleWebhookEvent } from "@/worker/handle-webhook-event";
import { createCustomer, createInvoice, createTenant } from "../db";
import { fakeJob, webhookEventsQueue } from "../queues";
import { checkoutSession, storeEvent, stripeEvent } from "../stripe-events";

const { add, getJob } = webhookEventsQueue;

// A payment event stored and picked up by the worker, as it stands the
// moment a job attempt for it fails.
async function eventInFlight() {
  const tenant = await createTenant();
  const customer = await createCustomer(tenant.id);
  const invoice = await createInvoice(customer, { amountDue: 2000 });
  const stored = await storeEvent(
    stripeEvent(
      "checkout.session.completed",
      checkoutSession({ id: invoice.stripeCheckoutSessionId!, amountTotal: 2000 }),
      { account: tenant.stripeAccountId }
    )
  );
  await prisma.webhookEvent.update({ where: { id: stored.id }, data: { status: "PROCESSING" } });
  return { tenant, invoice, eventId: stored.id };
}

const reload = (id: string) => prisma.webhookEvent.findUniqueOrThrow({ where: { id } });

describe("recordWebhookEventFailure", () => {
  it("notes the error of a failed attempt but leaves the event in flight", async () => {
    const { eventId } = await eventInFlight();

    await recordWebhookEventFailure(eventId, new Error("connection reset"), false);

    expect(await reload(eventId)).toMatchObject({
      status: "PROCESSING",
      lastError: "Error: connection reset",
      failedAt: null,
    });
  });

  it("dead-letters the event on its final failure", async () => {
    const { eventId } = await eventInFlight();

    await recordWebhookEventFailure(eventId, new Error("still failing"), true);

    expect(await reload(eventId)).toMatchObject({
      status: "FAILED",
      lastError: "Error: still failing",
      failedAt: expect.any(Date),
    });
  });

  it("never turns a processed event into a failure", async () => {
    // The job can fail after the event was processed, when only a follow-up
    // signal could not be enqueued. The payment is recorded; it isn't lost.
    const { eventId } = await eventInFlight();
    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: { status: "PROCESSED", processedAt: new Date() },
    });

    await recordWebhookEventFailure(eventId, new Error("could not enqueue signal"), true);

    expect(await reload(eventId)).toMatchObject({ status: "PROCESSED", lastError: null });
  });

  it("keeps the stored message short", async () => {
    const { eventId } = await eventInFlight();

    await recordWebhookEventFailure(eventId, new Error("x".repeat(5000)), true);

    expect((await reload(eventId)).lastError).toHaveLength(1000);
  });

  it("is cleared again once the event is processed", async () => {
    const { eventId } = await eventInFlight();
    await recordWebhookEventFailure(eventId, new Error("first attempt failed"), false);

    await handleWebhookEvent(eventId); // the retry succeeds

    expect(await reload(eventId)).toMatchObject({
      status: "PROCESSED",
      lastError: null,
      failedAt: null,
    });
  });
});

describe("replayWebhookEvent", () => {
  async function deadLetter() {
    const context = await eventInFlight();
    await recordWebhookEventFailure(context.eventId, new Error("Stripe was down"), true);
    return context;
  }

  it("puts a dead letter back through the pipeline", async () => {
    const { invoice, eventId } = await deadLetter();
    // The job that failed is still sitting in the queue's failed set.
    const failedJob = fakeJob("failed", "Stripe was down");
    getJob.mockResolvedValue(failedJob);

    const result = await replayWebhookEvent(eventId);

    expect(result).toBe("replayed");
    expect(await reload(eventId)).toMatchObject({ status: "RECEIVED", failedAt: null });
    // Removed first: add() is a no-op while a job with that id exists.
    expect(failedJob.remove).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledExactlyOnceWith(
      "checkout.session.completed",
      { webhookEventId: eventId },
      { jobId: eventId }
    );

    // ...and the worker then processes it like any other event.
    await handleWebhookEvent(eventId);
    expect((await reload(eventId)).status).toBe("PROCESSED");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe(
      "PAID"
    );
  });

  it("is safe to replay an event whose effects were already applied", async () => {
    // It failed after recording the payment: the invoice is PAID, the
    // Transaction exists, and only then did something throw.
    const { invoice, eventId } = await eventInFlight();
    await handleWebhookEvent(eventId);
    await prisma.webhookEvent.update({ where: { id: eventId }, data: { status: "FAILED" } });

    await replayWebhookEvent(eventId);
    await handleWebhookEvent(eventId);

    expect((await reload(eventId)).status).toBe("PROCESSED");
    expect(await prisma.transaction.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });

  it("replays once when requested twice at the same moment", async () => {
    const { eventId } = await deadLetter();

    const results = await Promise.all([replayWebhookEvent(eventId), replayWebhookEvent(eventId)]);

    expect(results.sort()).toEqual(["not_failed", "replayed"]);
    expect(add).toHaveBeenCalledOnce();
  });

  it("refuses an event that isn't a dead letter", async () => {
    const { eventId } = await eventInFlight();

    expect(await replayWebhookEvent(eventId)).toBe("not_failed");

    expect((await reload(eventId)).status).toBe("PROCESSING");
    expect(add).not.toHaveBeenCalled();
  });

  it("reports an event that doesn't exist", async () => {
    expect(await replayWebhookEvent("no-such-event")).toBe("not_found");
    expect(add).not.toHaveBeenCalled();
  });
});

describe("an event that keeps failing", () => {
  it("goes from in flight to dead letter to processed after a replay", async () => {
    // account.updated asks Stripe for the account's state; Stripe is down.
    const tenant = await createTenant();
    await prisma.user.update({ where: { id: tenant.id }, data: { onboardingComplete: false } });
    const stored = await storeEvent(
      stripeEvent(
        "account.updated",
        { id: tenant.stripeAccountId, object: "account" },
        { account: tenant.stripeAccountId }
      )
    );
    const retrieve = vi
      .spyOn(stripe.accounts, "retrieve")
      .mockRejectedValue(new Error("Stripe API unavailable"));

    // What BullMQ and the worker's `failed` listener do across the attempts.
    for (let attempt = 1; attempt <= 5; attempt++) {
      const error = await handleWebhookEvent(stored.id).catch((err: Error) => err);
      await recordWebhookEventFailure(stored.id, error, attempt === 5);
    }
    expect(await reload(stored.id)).toMatchObject({
      status: "FAILED",
      lastError: "Error: Stripe API unavailable",
    });

    // Stripe recovers; an operator replays the dead letter.
    retrieve.mockResolvedValue({ details_submitted: true, charges_enabled: true } as never);
    expect(await replayWebhookEvent(stored.id)).toBe("replayed");
    await handleWebhookEvent(stored.id);

    expect(await reload(stored.id)).toMatchObject({ status: "PROCESSED", lastError: null });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: tenant.id } })).onboardingComplete).toBe(
      true
    );
  });
});
