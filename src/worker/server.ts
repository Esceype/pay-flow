import express from "express";
import basicAuth from "express-basic-auth";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { env } from "../lib/env";
import { getWebhookEventsQueue } from "../lib/queue";

const ADMIN_BASE_PATH = "/admin/queues";

// Bull Board must never be reachable without credentials — it exposes job
// payloads, which can include Stripe event data. Fail loudly at startup
// rather than silently serving it unauthenticated.
function requireBullBoardCredentials() {
  if (!env.BULL_BOARD_USER || !env.BULL_BOARD_PASSWORD) {
    throw new Error(
      "BULL_BOARD_USER and BULL_BOARD_PASSWORD must be set — refusing to start the worker admin server without them."
    );
  }
  return { user: env.BULL_BOARD_USER, password: env.BULL_BOARD_PASSWORD };
}

export function startAdminServer() {
  const { user, password } = requireBullBoardCredentials();

  const app = express();

  // Unauthenticated on purpose: this is what Docker Compose / an
  // orchestrator polls to decide if the worker container is alive.
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(ADMIN_BASE_PATH);

  createBullBoard({
    queues: [new BullMQAdapter(getWebhookEventsQueue())],
    serverAdapter,
  });

  app.use(
    ADMIN_BASE_PATH,
    basicAuth({ users: { [user]: password }, challenge: true }),
    serverAdapter.getRouter()
  );

  app.listen(env.WORKER_HTTP_PORT, () => {
    console.log(
      `[worker] admin server listening on :${env.WORKER_HTTP_PORT} (Bull Board at ${ADMIN_BASE_PATH}, auth required)`
    );
  });
}
