import type { Customer, User } from "@prisma/client";
import { prisma } from "./prisma";
import { stripe } from "./stripe";
import { env } from "./env";

// Currencies PayFlow invoices in. Deliberately a short allowlist: all are
// two-decimal currencies, so "amount × 100 = minor units" holds (it would
// be 100× wrong for zero-decimal currencies like JPY). minAmount mirrors
// Stripe's per-currency minimum charge, so an invoice below it is rejected
// with a clear message instead of a Stripe error at checkout creation.
export const CURRENCIES = {
  usd: { label: "USD", minAmount: 50 },
  eur: { label: "EUR", minAmount: 50 },
  gbp: { label: "GBP", minAmount: 30 },
} as const;

export type Currency = keyof typeof CURRENCIES;

export class BillingError extends Error {}

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
  if (previousSessionId) {
    const previous = await stripe.checkout.sessions.retrieve(
      previousSessionId,
      {},
      { stripeAccount: tenant.stripeAccountId }
    );
    if (previous.status === "open" && previous.url) return previous.url;
    // "complete" but not FAILED: paid, or an async payment still settling —
    // a second session would risk charging twice.
    if (previous.status === "complete" && invoice.status !== "FAILED") {
      throw new BillingError("already_completed");
    }
    // Otherwise expired (or complete with a failed async payment): fall
    // through and issue a fresh session for the same invoice.
  }

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
      // Public pages: the payer is the tenant's customer, not a PayFlow
      // user, so they must not land on the (login-gated) dashboard.
      success_url: new URL("/pay/success", env.NEXTAUTH_URL).toString(),
      cancel_url: new URL("/pay/canceled", env.NEXTAUTH_URL).toString(),
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
