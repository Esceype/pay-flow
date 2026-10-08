import type { BillingInterval, InvoiceStatus, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Database helpers for the integration tests: a clean slate between tests,
// and factories for the rows the scenarios start from. Each factory sets
// only what the schema requires plus what a test passes in.

export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Transaction", "Invoice", "Subscription", "Customer", "WebhookEvent", "MaterializedRevenueStats", "User" CASCADE`
  );
}

let sequence = 0;
const next = () => ++sequence;

export async function createTenant(overrides: { stripeConnectedAt?: Date } = {}) {
  const n = next();
  return prisma.user.create({
    data: {
      email: `tenant-${n}@example.test`,
      stripeAccountId: `acct_test_${n}`,
      onboardingComplete: true,
      stripeConnectedAt: overrides.stripeConnectedAt ?? new Date("2026-01-01T00:00:00Z"),
    },
  });
}

export async function createCustomer(userId: string) {
  const n = next();
  return prisma.customer.create({
    data: { userId, email: `customer-${n}@example.test`, stripeCustomerId: `cus_test_${n}` },
  });
}

export async function createInvoice(
  customer: { id: string; userId: string },
  overrides: { stripeCheckoutSessionId?: string; status?: InvoiceStatus; amountDue?: number } = {}
) {
  const n = next();
  return prisma.invoice.create({
    data: {
      customerId: customer.id,
      userId: customer.userId,
      requestKey: `request-${n}`,
      stripeCheckoutSessionId: overrides.stripeCheckoutSessionId ?? `cs_test_${n}`,
      status: overrides.status ?? "PENDING",
      amountDue: overrides.amountDue ?? 2000,
      currency: "usd",
    },
  });
}

// As the dashboard creates it: our row exists, the customer hasn't checked
// out yet, so there is no Stripe subscription id. Pass one to start from an
// already-linked subscription instead.
export async function createSubscription(
  customer: { id: string; userId: string },
  overrides: {
    stripeSubscriptionId?: string;
    status?: SubscriptionStatus;
    lastEventAt?: Date;
    amount?: number;
    interval?: BillingInterval;
  } = {}
) {
  const n = next();
  return prisma.subscription.create({
    data: {
      customerId: customer.id,
      userId: customer.userId,
      requestKey: `request-${n}`,
      stripeCheckoutSessionId: `cs_test_sub_${n}`,
      stripeSubscriptionId: overrides.stripeSubscriptionId,
      status: overrides.status ?? "AWAITING_CHECKOUT",
      lastEventAt: overrides.lastEventAt,
      amount: overrides.amount ?? 2900,
      currency: "usd",
      interval: overrides.interval ?? "MONTH",
    },
  });
}
