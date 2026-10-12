import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { EVENTS_BASE_PATH, eventsRouter } from "@/worker/admin-events";
import { recordWebhookEventFailure } from "@/worker/dead-letter";
import { createTenant } from "../db";
import { webhookEventsQueue } from "../queues";
import { storeEvent, stripeEvent } from "../stripe-events";

// The operator page, served for real on a throwaway port. The Basic Auth in
// front of it is the admin server's (src/worker/server.ts), not the
// router's, so it isn't part of this.
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(EVENTS_BASE_PATH, eventsRouter());
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}${EVENTS_BASE_PATH}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function deadLetter(error: string) {
  const tenant = await createTenant();
  const stored = await storeEvent(
    stripeEvent("customer.subscription.updated", { id: "sub_1" }, { account: tenant.stripeAccountId })
  );
  await recordWebhookEventFailure(stored.id, new Error(error), true);
  return { tenant, eventId: stored.id, stripeEventId: stored.stripeEventId };
}

describe("GET /admin/events", () => {
  it("says so when there are no dead letters", async () => {
    const response = await fetch(baseUrl);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("None. Every event received so far");
  });

  it("lists dead letters with their tenant and the reason they failed", async () => {
    const { tenant, stripeEventId } = await deadLetter("Stripe API unavailable");

    const html = await (await fetch(baseUrl)).text();

    expect(html).toContain("customer.subscription.updated");
    expect(html).toContain(stripeEventId);
    expect(html).toContain(tenant.email);
    expect(html).toContain("Error: Stripe API unavailable");
    expect(html).toMatch(/<strong>1<\/strong>dead letters/);
  });

  it("escapes what it renders", async () => {
    // Error text comes from wherever the failure did, including third
    // parties; it must not be able to inject markup into an admin page.
    await deadLetter(`<script>alert("x")</script>`);

    const html = await (await fetch(baseUrl)).text();

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("counts events stuck past the relay's threshold", async () => {
    const tenant = await createTenant();
    const stored = await storeEvent(
      stripeEvent("customer.created", { id: "cus_1" }, { account: tenant.stripeAccountId })
    );
    await prisma.webhookEvent.update({
      where: { id: stored.id },
      data: { receivedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const html = await (await fetch(baseUrl)).text();

    expect(html).toMatch(/<strong>1<\/strong>stuck/);
  });
});

describe("POST /admin/events/:id/replay", () => {
  const replay = (eventId: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/${eventId}/replay`, { method: "POST", headers, redirect: "manual" });

  it("replays the event and redirects back to the list", async () => {
    const { eventId } = await deadLetter("Stripe API unavailable");

    const response = await replay(eventId);

    // 303: a refresh of the page that follows must not replay again.
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${EVENTS_BASE_PATH}?result=replayed`);
    expect(webhookEventsQueue.add).toHaveBeenCalledOnce();
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: eventId } })).status).toBe(
      "RECEIVED"
    );
  });

  it("reports an event that is no longer a dead letter", async () => {
    const { eventId } = await deadLetter("Stripe API unavailable");
    await replay(eventId);

    const again = await replay(eventId);

    expect(again.headers.get("location")).toBe(`${EVENTS_BASE_PATH}?result=not_failed`);
    expect(webhookEventsQueue.add).toHaveBeenCalledOnce();
  });

  it("refuses a request that another site made the browser send", async () => {
    // The browser would attach the operator's Basic Auth credentials to it.
    const { eventId } = await deadLetter("Stripe API unavailable");

    const response = await replay(eventId, { "Sec-Fetch-Site": "cross-site" });

    expect(response.status).toBe(403);
    expect(webhookEventsQueue.add).not.toHaveBeenCalled();
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: eventId } })).status).toBe(
      "FAILED"
    );
  });

  it("accepts the form submitted from its own page", async () => {
    const { eventId } = await deadLetter("Stripe API unavailable");

    const response = await replay(eventId, { "Sec-Fetch-Site": "same-origin" });

    expect(response.status).toBe(303);
  });
});
