// Sends a validly signed, synthetic Connect event to the local webhook
// endpoint — a way to exercise the pipeline (the outbox, the worker, the
// relay, dead letters) without the Stripe CLI or a real Stripe object.
//
//   node scripts/send-test-event.mjs <event.type> [--account acct_...] [--no-account] [--id evt_...]
//
// Examples:
//   node scripts/send-test-event.mjs customer.created
//       stored, acknowledged, nothing to do (no processor for that type)
//   node scripts/send-test-event.mjs account.application.deauthorized --no-account
//       cannot be processed -> a dead letter on /admin/events, ready to replay
//   node scripts/send-test-event.mjs customer.created --id evt_same   (twice)
//       a duplicate delivery: stored once, processed once
//
// The event is signed with STRIPE_CONNECT_WEBHOOK_SECRET from .env, so the
// endpoint verifies it exactly as it would Stripe's. The payload carries no
// real Stripe object: processors that look one up will find nothing.
import "dotenv/config";
import Stripe from "stripe";

const args = process.argv.slice(2);
const type = args.find((arg) => !arg.startsWith("--"));
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

if (!type) {
  console.error("usage: node scripts/send-test-event.mjs <event.type> [--account acct_...] [--no-account] [--id evt_...]");
  process.exit(1);
}
const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
if (!secret) {
  console.error("STRIPE_CONNECT_WEBHOOK_SECRET is not set (.env)");
  process.exit(1);
}

const event = {
  id: option("id") ?? `evt_test_${Date.now()}`,
  object: "event",
  type,
  ...(!args.includes("--no-account") && { account: option("account") ?? "acct_test_synthetic" }),
  created: Math.floor(Date.now() / 1000),
  livemode: false,
  data: { object: { id: "obj_test_synthetic", object: "test" } },
};

const payload = JSON.stringify(event);
// Signing needs no API key — only the endpoint secret.
const signature = new Stripe("sk_test_unused").webhooks.generateTestHeaderString({ payload, secret });
const url =
  option("url") ?? `${process.env.NEXTAUTH_URL ?? "http://localhost:3000"}/api/webhooks/stripe-connect`;

const started = Date.now();
try {
  const response = await fetch(url, {
    method: "POST",
    headers: { "stripe-signature": signature, "content-type": "application/json" },
    body: payload,
  });
  console.log(`${event.id} (${type}) -> HTTP ${response.status} in ${Date.now() - started}ms`);
} catch (err) {
  console.error(`${event.id} (${type}) -> request failed: ${err.message}`);
  process.exit(1);
}
