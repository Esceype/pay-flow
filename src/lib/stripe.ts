import Stripe from "stripe";
import { env } from "./env";

// Platform-level client only — never used to act on a connected account's
// behalf without passing `{ stripeAccount: user.stripeAccountId }`
// explicitly at the call site (see docs/adr/003-stripe-connect-multitenancy.md).

let instance: Stripe | undefined;

function getStripeClient(): Stripe {
  // Lazy, not constructed at module top level: reading env.STRIPE_SECRET_KEY
  // at import time is exactly what breaks `next build`'s page-data
  // collection (see env.ts) — this must only happen when a request
  // actually calls the Stripe API. An empty/placeholder key at that point
  // just makes the call fail with a clear Stripe error, not a build error.
  return (instance ??= new Stripe(env.STRIPE_SECRET_KEY ?? ""));
}

export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    const client = getStripeClient();
    const value = client[prop as keyof Stripe];
    return typeof value === "function" ? value.bind(client) : value;
  },
});
