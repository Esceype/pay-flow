import type { BillingInterval, Customer, User } from "@prisma/client";
import { prisma } from "./prisma";
import { stripe } from "./stripe";
import { env } from "./env";
import { isTerminal, SUBSCRIPTION_METADATA_KEY } from "./subscription-state";

// Currencies PayFlow bills in. Deliberately a short allowlist: all are
// two-decimal currencies, so "amount × 100 = minor units" holds (it would
// be 100× wrong for zero-decimal currencies like JPY). minAmount mirrors
// Stripe's per-currency minimum charge, so an amount below it is rejected
// with a clear message instead of a Stripe error at checkout creation.
export const CURRENCIES = {
  usd: { label: "USD", minAmount: 50 },
  eur: { label: "EUR", minAmount: 50 },
  gbp: { label: "GBP", minAmount: 30 },
} as const;

export type Currency = keyof typeof CURRENCIES;

// Stripe's ceiling for a single charge in these currencies (999,999.99),
// and comfortably inside the Int columns the amounts are stored in.
export const MAX_AMOUNT = 99_999_999;

// Billing periods PayFlow offers for new subscriptions. The database enum
// also has DAY/WEEK, but only to mirror subscriptions edited in Stripe.
export const INTERVALS = {
  month: { label: "Monthly", per: "month", value: "MONTH" },
  year: { label: "Yearly", per: "year", value: "YEAR" },
} as const satisfies Record<string, { label: string; per: string; value: BillingInterval }>;

export type Interval = keyof typeof INTERVALS;

export class BillingError extends Error {}

// An amount as typed into a form: "19", "19.9" or "19.99".
export const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

// "19.99" -> 1999. Works on the string, not a float, so the result is
// exact (19.99 * 100 is 1998.9999999999998 in floating point). Expects
// input that already matches AMOUNT_PATTERN.
export function toMinorUnits(amount: string): number {
  const [whole, fraction = ""] = amount.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

// Platform fee for an invoice amount, in minor units. Rounded down so the
// tenant is never charged more than the advertised rate.
export function applicationFeeFor(amount: number, feeBps: number = env.PLATFORM_FEE_BPS): number {
  return Math.floor((amount * feeBps) / 10_000);
}

// A checkout_url query param is rendered as a "share this payment link"
// link, so anything that isn't a Stripe-hosted Checkout URL is dropped —
// otherwise a crafted /dashboard/invoices?checkout_url=... link would make
// an arbitrary site look like a PayFlow payment link.
export function isStripeCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com";
  } catch {
    return false;
  }
}

type Tenant = Pick<User, "id"> & { stripeAccountId: string };

// Intent-first: the Customer row already exists (it's written before any
// Stripe call), and this makes sure its Stripe counterpart exists too. The
// idempotency key is derived from our own row id, so a retry — after a
// timeout, a crash between the Stripe call and the DB update, or two
// concurrent calls — gets the same Stripe customer back instead of creating
// a second one. Called on customer creation and again, lazily, before
// creating a Checkout Session, so a customer whose first Stripe sync
// failed heals itself on first use.
export async function ensureStripeCustomer(
  customer: Pick<Customer, "id" | "email" | "name" | "stripeCustomerId">,
  tenant: Tenant
): Promise<string> {
  if (customer.stripeCustomerId) return customer.stripeCustomerId;

  // Created on the connected account, not the platform — every Stripe
  // call made on a tenant's behalf passes stripeAccount explicitly
  // (docs/adr/003-stripe-connect-multitenancy.md).
  const stripeCustomer = await stripe.customers.create(
    {
      email: customer.email,
      name: customer.name ?? undefined,
      metadata: { payflowCustomerId: customer.id },
    },
    { stripeAccount: tenant.stripeAccountId, idempotencyKey: `customer-${customer.id}` }
  );

  await prisma.customer.update({
    where: { id: customer.id },
    data: { stripeCustomerId: stripeCustomer.id },
  });
  return stripeCustomer.id;
}

// Public pages: whoever completes Checkout is the tenant's customer, not a
// PayFlow user, so they must not land on the (login-gated) dashboard.
function checkoutRedirects() {
  return {
    success_url: new URL("/pay/success", env.NEXTAUTH_URL).toString(),
    cancel_url: new URL("/pay/canceled", env.NEXTAUTH_URL).toString(),
  };
}

type PreviousSession =
  | { state: "none" | "complete" | "expired" }
  | { state: "open"; url: string };

// Where the Checkout Session a record already points at stands. Invoices
// and subscriptions share the rule built on this: reuse an open session,
// replace an expired one, never issue a second one next to a completed one.
async function previousSessionState(
  sessionId: string | null,
  tenant: Tenant
): Promise<PreviousSession> {
  if (!sessionId) return { state: "none" };

  const session = await stripe.checkout.sessions.retrieve(
    sessionId,
    {},
    { stripeAccount: tenant.stripeAccountId }
  );
  if (session.status === "open" && session.url) return { state: "open", url: session.url };
  return { state: session.status === "complete" ? "complete" : "expired" };
}

// Returns a payable Checkout URL for an invoice, creating (or re-creating)
// the Checkout Session when needed:
// - no session yet (intent-first row, or session creation failed before)
// - the session expired (24h lifetime), or its async payment failed
// An open session is simply reused. ADR-006.
export async function getOrCreatePaymentLink(invoiceId: string, tenant: Tenant): Promise<string> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, userId: tenant.id },
    include: { customer: true },
  });
  if (!invoice) throw new BillingError("invalid_invoice");
  if (invoice.status === "PAID" || invoice.status === "VOID") throw new BillingError("not_payable");

  const previousSessionId = invoice.stripeCheckoutSessionId;
  const previous = await previousSessionState(previousSessionId, tenant);
  if (previous.state === "open") return previous.url;
  // "complete" but not FAILED: paid, or an async payment still settling —
  // a second session would risk charging twice.
  if (previous.state === "complete" && invoice.status !== "FAILED") {
    throw new BillingError("already_completed");
  }
  // Otherwise none, expired, or complete with a failed async payment:
  // issue a fresh session for the same invoice.

  const stripeCustomerId = await ensureStripeCustomer(invoice.customer, tenant);

  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      customer: stripeCustomerId,
      // Lets anyone looking at the session in the tenant's Stripe Dashboard
      // trace it back to our invoice.
      client_reference_id: invoice.id,
      metadata: { invoiceId: invoice.id },
      line_items: [
        {
          price_data: {
            currency: invoice.currency,
            product_data: { name: `Invoice for ${invoice.customer.email}` },
            unit_amount: invoice.amountDue,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        // Direct charge on the connected account; the platform's cut is
        // collected as an application fee (0 = none).
        ...(invoice.applicationFeeAmount > 0 && {
          application_fee_amount: invoice.applicationFeeAmount,
        }),
        metadata: { invoiceId: invoice.id },
      },
      ...checkoutRedirects(),
    },
    {
      stripeAccount: tenant.stripeAccountId,
      // One key per (invoice, session it replaces): a double-click or retry
      // for the same step returns the same session, while regenerating
      // after expiry gets a genuinely new one.
      idempotencyKey: `invoice-${invoice.id}-after-${previousSessionId ?? "none"}`,
    }
  );

  // Compare-and-set on the session id we started from: if a concurrent
  // request already replaced it, don't overwrite theirs.
  const { count } = await prisma.invoice.updateMany({
    where: { id: invoice.id, stripeCheckoutSessionId: previousSessionId },
    data: { stripeCheckoutSessionId: session.id, status: "PENDING" },
  });
  if (count === 0) {
    const current = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    // Same idempotency key -> the concurrent request got this same session.
    if (current.stripeCheckoutSessionId !== session.id) throw new BillingError("conflict");
  }

  if (!session.url) throw new BillingError("missing_url");
  return session.url;
}

// The subscription counterpart of getOrCreatePaymentLink(): a Checkout URL
// (mode "subscription") for a row still AWAITING_CHECKOUT. Stripe creates
// the actual subscription only when the customer completes it; from then
// on the worker owns the row's state (ADR-007), which is why this refuses
// anything that is past AWAITING_CHECKOUT.
export async function getOrCreateSubscriptionLink(
  subscriptionId: string,
  tenant: Tenant
): Promise<string> {
  const subscription = await prisma.subscription.findFirst({
    where: { id: subscriptionId, userId: tenant.id },
    include: { customer: true },
  });
  if (!subscription) throw new BillingError("invalid_subscription");
  if (subscription.status !== "AWAITING_CHECKOUT") throw new BillingError("not_awaiting_checkout");

  const previousSessionId = subscription.stripeCheckoutSessionId;
  const previous = await previousSessionState(previousSessionId, tenant);
  if (previous.state === "open") return previous.url;
  // Completed: the subscription exists in Stripe and its first events are
  // on their way — a second session would subscribe the customer twice.
  if (previous.state === "complete") throw new BillingError("already_completed");

  const stripeCustomerId = await ensureStripeCustomer(subscription.customer, tenant);

  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      customer: stripeCustomerId,
      client_reference_id: subscription.id,
      metadata: { [SUBSCRIPTION_METADATA_KEY]: subscription.id },
      line_items: [
        {
          price_data: {
            currency: subscription.currency,
            product_data: { name: `Subscription for ${subscription.customer.email}` },
            unit_amount: subscription.amount,
            recurring: {
              interval: subscription.interval.toLowerCase() as Lowercase<BillingInterval>,
              interval_count: subscription.intervalCount,
            },
          },
          quantity: 1,
        },
      ],
      subscription_data: {
        // Copied by Stripe onto the subscription and onto every invoice it
        // generates — how the worker ties their events back to this row
        // before it knows the Stripe subscription id.
        metadata: { [SUBSCRIPTION_METADATA_KEY]: subscription.id },
        // The platform's cut of every billing period (direct charges).
        ...(subscription.applicationFeeBps > 0 && {
          application_fee_percent: subscription.applicationFeeBps / 100,
        }),
      },
      ...checkoutRedirects(),
    },
    {
      stripeAccount: tenant.stripeAccountId,
      idempotencyKey: `subscription-${subscription.id}-after-${previousSessionId ?? "none"}`,
    }
  );

  // Only while it's still awaiting checkout through the session we started
  // from — same compare-and-set as for invoices.
  const { count } = await prisma.subscription.updateMany({
    where: {
      id: subscription.id,
      status: "AWAITING_CHECKOUT",
      stripeCheckoutSessionId: previousSessionId,
    },
    data: { stripeCheckoutSessionId: session.id },
  });
  if (count === 0) {
    const current = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    if (current.stripeCheckoutSessionId !== session.id) throw new BillingError("conflict");
  }

  if (!session.url) throw new BillingError("missing_url");
  return session.url;
}

// Asks Stripe to cancel a subscription. Deliberately does NOT touch our
// row: its status changes when the worker processes Stripe's
// customer.subscription.deleted, like every other status change. Writing
// CANCELED here as well would be a second writer racing the webhook.
export async function requestSubscriptionCancellation(
  subscriptionId: string,
  tenant: Tenant
): Promise<void> {
  const subscription = await prisma.subscription.findFirst({
    where: { id: subscriptionId, userId: tenant.id },
  });
  if (!subscription) throw new BillingError("invalid_subscription");
  if (!subscription.stripeSubscriptionId || isTerminal(subscription.status)) {
    throw new BillingError("not_cancelable");
  }

  try {
    await stripe.subscriptions.cancel(
      subscription.stripeSubscriptionId,
      {},
      {
        stripeAccount: tenant.stripeAccountId,
        idempotencyKey: `subscription-cancel-${subscription.id}`,
      }
    );
  } catch (err) {
    // Already gone in Stripe is the outcome we wanted; the event that says
    // so is processed (or about to be) like any other.
    if ((err as { code?: string }).code !== "resource_missing") throw err;
  }
}

// Removes a subscription the customer never completed Checkout for. There
// is no billing history to keep, so the row is deleted — but only after
// making sure its Checkout Session can no longer be completed. Otherwise
// the customer could subscribe a moment later, and Stripe would hold a
// live, charging subscription whose events point at a row that's gone.
export async function discardPendingSubscription(
  subscriptionId: string,
  tenant: Tenant
): Promise<void> {
  const subscription = await prisma.subscription.findFirst({
    where: { id: subscriptionId, userId: tenant.id },
  });
  if (!subscription) return;
  if (subscription.status !== "AWAITING_CHECKOUT" || subscription.stripeSubscriptionId) {
    throw new BillingError("not_discardable");
  }

  const previous = await previousSessionState(subscription.stripeCheckoutSessionId, tenant);
  if (previous.state === "complete") throw new BillingError("already_completed");
  if (previous.state === "open" && subscription.stripeCheckoutSessionId) {
    // Throws if the customer completed it since the check above — in which
    // case we stop here, before deleting anything.
    await stripe.checkout.sessions.expire(
      subscription.stripeCheckoutSessionId,
      {},
      { stripeAccount: tenant.stripeAccountId }
    );
  }

  await prisma.subscription.deleteMany({
    where: {
      id: subscription.id,
      userId: tenant.id,
      status: "AWAITING_CHECKOUT",
      stripeSubscriptionId: null,
    },
  });
}
