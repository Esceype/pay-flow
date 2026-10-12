import { Router, type NextFunction, type Request, type Response } from "express";
import { log } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { replayWebhookEvent, type ReplayResult } from "./dead-letter";
import { STALE_AFTER_MS } from "./relay";

// Operator view of the webhook pipeline at the data level (ADR-009): how
// many events are in each state, and the dead letters with the reason they
// failed and a way to replay them.
//
// Bull Board, next door, shows *jobs*; this shows *events* — the durable
// rows. They usually agree, but only the row survives Redis losing its
// data, and only the row knows which tenant an event belongs to.
//
// Served by the worker's admin server behind the same Basic Auth as Bull
// Board: it is an operator tool, not something tenants see.

export const EVENTS_BASE_PATH = "/admin/events";

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const formatTime = (date: Date | null) =>
  date ? `${date.toISOString().replace("T", " ").slice(0, 19)} UTC` : "—";

const REPLAY_MESSAGES: Record<ReplayResult, string> = {
  replayed: "Event sent back through the pipeline. It leaves this list once it is processed.",
  not_failed: "That event is no longer a dead letter — it was already replayed or processed.",
  not_found: "That event doesn't exist.",
};

// Browsers attach Basic Auth credentials to any request for this origin,
// including a form on another site posting here. Fetch metadata says where
// a request came from; state-changing requests from another site are
// refused. (Non-browser clients send no such header and are let through —
// they had to supply the credentials themselves.)
function refuseCrossSite(req: Request, res: Response, next: NextFunction) {
  const site = req.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    res.status(403).send("Cross-site request refused");
    return;
  }
  next();
}

async function renderPage(notice: string | null): Promise<string> {
  const now = new Date();
  const [counts, stuck, deadLetters] = await Promise.all([
    prisma.webhookEvent.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.webhookEvent.count({
      where: {
        status: { in: ["RECEIVED", "PROCESSING"] },
        receivedAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) },
      },
    }),
    prisma.webhookEvent.findMany({
      where: { status: "FAILED" },
      orderBy: { receivedAt: "desc" },
      take: 100,
      select: {
        id: true,
        stripeEventId: true,
        stripeAccountId: true,
        type: true,
        receivedAt: true,
        failedAt: true,
        lastError: true,
        user: { select: { email: true } },
      },
    }),
  ]);

  const countOf = (status: string) =>
    counts.find((entry) => entry.status === status)?._count._all ?? 0;

  const rows = deadLetters
    .map(
      (event) => `
      <tr>
        <td>${escapeHtml(formatTime(event.receivedAt))}<br><small>failed ${escapeHtml(formatTime(event.failedAt))}</small></td>
        <td><code>${escapeHtml(event.type)}</code><br><small>${escapeHtml(event.stripeEventId)}</small></td>
        <td>${escapeHtml(event.user?.email ?? "no tenant")}<br><small>${escapeHtml(event.stripeAccountId)}</small></td>
        <td class="error">${escapeHtml(event.lastError ?? "no error recorded")}</td>
        <td>
          <form method="post" action="${EVENTS_BASE_PATH}/${encodeURIComponent(event.id)}/replay">
            <button type="submit">Replay</button>
          </form>
        </td>
      </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Webhook events — PayFlow</title>
  <style>
    body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; color: #171717; }
    nav { margin-bottom: 1.5rem; } nav a { margin-right: 1rem; }
    .counts { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0; }
    .counts div { border: 1px solid #d4d4d4; border-radius: 6px; padding: .5rem 1rem; }
    .counts strong { display: block; font-size: 1.4rem; }
    .warn { border-color: #b45309 !important; color: #b45309; }
    .notice { background: #f5f5f5; border-radius: 6px; padding: .6rem 1rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; vertical-align: top; padding: .5rem .6rem; border-bottom: 1px solid #e5e5e5; }
    th { color: #737373; font-weight: 500; }
    small { color: #737373; } code { font-size: 13px; }
    .error { color: #b91c1c; max-width: 26rem; overflow-wrap: anywhere; }
    button { padding: .3rem .8rem; cursor: pointer; }
  </style>
</head>
<body>
  <nav><strong>Webhook events</strong> <a href="/admin/queues">Queues (Bull Board)</a></nav>
  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
  <div class="counts">
    <div><strong>${countOf("RECEIVED")}</strong>received</div>
    <div><strong>${countOf("PROCESSING")}</strong>processing</div>
    <div><strong>${countOf("PROCESSED")}</strong>processed</div>
    <div class="${countOf("FAILED") > 0 ? "warn" : ""}"><strong>${countOf("FAILED")}</strong>dead letters</div>
    <div class="${stuck > 0 ? "warn" : ""}"><strong>${stuck}</strong>stuck &gt; ${STALE_AFTER_MS / 60000} min</div>
  </div>
  <p><small>"Stuck" events are received or processing for longer than the relay's threshold. The relay re-enqueues them or marks them failed about once a minute; a number that stays above zero means the queue itself is unreachable or backed up.</small></p>
  <h2>Dead letters${deadLetters.length === 100 ? " (latest 100)" : ""}</h2>
  ${
    deadLetters.length === 0
      ? "<p>None. Every event received so far was processed or is still in flight.</p>"
      : `<table>
    <thead><tr><th>Received</th><th>Event</th><th>Tenant</th><th>Last error</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
  }
</body>
</html>`;
}

export function eventsRouter(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const result = req.query.result as ReplayResult | undefined;
    const notice = result && result in REPLAY_MESSAGES ? REPLAY_MESSAGES[result] : null;
    res.type("html").send(await renderPage(notice));
  });

  router.post("/:id/replay", refuseCrossSite, async (req, res) => {
    const webhookEventId = String(req.params.id);
    const result = await replayWebhookEvent(webhookEventId);
    log.info("dead letter replay requested", { webhookEventId, result });
    // Post/Redirect/Get: a refresh of the result page must not replay again.
    res.redirect(303, `${EVENTS_BASE_PATH}?result=${result}`);
  });

  return router;
}
