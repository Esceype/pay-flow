import type { WebhookEvent } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { handleWebhookEvent } from "@/worker/handle-webhook-event";
import { storeEvent, type TestStripeEvent } from "./stripe-events";

// Stores an event and runs it through the worker's job handler — what
// happens to a delivered event once the webhook route has acknowledged it.
// Returns the WebhookEvent row as it stands afterwards.
export async function processEvent(event: TestStripeEvent): Promise<WebhookEvent> {
  const stored = await storeEvent(event);
  await handleWebhookEvent(stored.id);
  return prisma.webhookEvent.findUniqueOrThrow({ where: { id: stored.id } });
}
