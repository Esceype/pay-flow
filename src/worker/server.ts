import express from "express";
import basicAuth from "express-basic-auth";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import {
  getNotificationsQueue,
  getRevenueStatsQueue,
  getWebhookEventsQueue,
} from "../lib/queue";
import { EVENTS_BASE_PATH, eventsRouter } from "./admin-events";

const QUEUES_BASE_PATH = "/admin/queues";

// The admin pages must never be reachable without credentials — they expose
// job payloads and Stripe event data. Fail loudly at startup rather than
// silently serving them unauthenticated.
function requireAdminCredentials() {
  if (!env.BULL_BOARD_USER || !env.BULL_BOARD_PASSWORD) {
    throw new Error(
      "BULL_BOARD_USER and BULL_BOARD_PASSWORD must be set — refusing to start the worker admin server without them."
    );
  }
  return { user: env.BULL_BOARD_USER, password: env.BULL_BOARD_PASSWORD };
}

export function startAdminServer() {
  const { user, password } = requireAdminCredentials();

  const app = express();

  // Unauthenticated on purpose: this is what Docker Compose / an
  // orchestrator polls to decide if the worker container is alive.
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // Everything under /admin: one gate, in front of both tools.
  app.use("/admin", basicAuth({ users: { [user]: password }, challenge: true }));

  // Jobs, per queue (Bull Board).
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(QUEUES_BASE_PATH);
  createBullBoard({
    queues: [
      new BullMQAdapter(getWebhookEventsQueue()),
      new BullMQAdapter(getRevenueStatsQueue()),
      new BullMQAdapter(getNotificationsQueue()),
    ],
    serverAdapter,
    options: {
      uiConfig: { miscLinks: [{ text: "Webhook events & dead letters", url: EVENTS_BASE_PATH }] },
    },
  });
  app.use(QUEUES_BASE_PATH, serverAdapter.getRouter());

  // Events, as durable rows: states, dead letters, replay (ADR-009).
  app.use(EVENTS_BASE_PATH, eventsRouter());

  app.listen(env.WORKER_HTTP_PORT, () => {
    log.info("admin server listening", {
      port: env.WORKER_HTTP_PORT,
      paths: [QUEUES_BASE_PATH, EVENTS_BASE_PATH],
    });
  });
}
