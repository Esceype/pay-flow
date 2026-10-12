"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import {
  AMOUNT_PATTERN,
  BillingError,
  CURRENCIES,
  discardPendingSubscription,
  getOrCreateSubscriptionLink,
  INTERVALS,
  MAX_AMOUNT,
  requestSubscriptionCancellation,
  toMinorUnits,
  type Currency,
  type Interval,
} from "@/lib/billing";
import { authorizeTenantAction, redirectForTenantError } from "@/lib/tenant";

const subscriptionSchema = z.object({
  customerId: z.string().min(1),
  // Price per billing period, as typed (e.g. "29.00").
  amount: z.string().trim().regex(AMOUNT_PATTERN),
  currency: z.enum(Object.keys(CURRENCIES) as [Currency, ...Currency[]]),
  interval: z.enum(Object.keys(INTERVALS) as [Interval, ...Interval[]]),
  // Per-render form token, as on the invoice form: a double-submit reuses
  // the subscription it created instead of adding a second one.
  requestKey: z.string().uuid(),
});

function linkRedirect(checkoutUrl: string): never {
  redirect(`/dashboard/subscriptions?checkout_url=${encodeURIComponent(checkoutUrl)}`);
}

// See the control-flow note in customers/actions.ts — redirect() must never
// be called from inside a try block whose own catch would swallow its
// internal throw.
export async function createSubscription(formData: FormData) {
  let user;
  try {
    user = await authorizeTenantAction();
  } catch (err) {
    redirectForTenantError(err, "/dashboard/subscriptions");
  }

  const parsed = subscriptionSchema.safeParse({
    customerId: formData.get("customerId"),
    amount: formData.get("amount"),
    currency: formData.get("currency"),
    interval: formData.get("interval"),
    requestKey: formData.get("requestKey"),
  });
  if (!parsed.success) {
    redirect("/dashboard/subscriptions?error=invalid_input");
  }

  const amount = toMinorUnits(parsed.data.amount);
  if (amount < CURRENCIES[parsed.data.currency].minAmount) {
    redirect("/dashboard/subscriptions?error=amount_too_small");
  }
  if (amount > MAX_AMOUNT) {
    redirect("/dashboard/subscriptions?error=amount_too_large");
  }

  const customer = await prisma.customer.findFirst({
    where: { id: parsed.data.customerId, userId: user.id },
    select: { id: true },
  });
  if (!customer) {
    redirect("/dashboard/subscriptions?error=invalid_customer");
  }

  // Intent-first, as for invoices (ADR-006): our row exists, in
  // AWAITING_CHECKOUT, before anything exists in Stripe. Its id keys the
  // Checkout Session idempotently and travels in the Stripe subscription's
  // metadata, which is how the worker later ties Stripe's events to it.
  let subscriptionId: string;
  try {
    const subscription = await prisma.subscription.create({
      data: {
        customerId: customer.id,
        userId: user.id,
        requestKey: parsed.data.requestKey,
        amount,
        currency: parsed.data.currency,
        interval: INTERVALS[parsed.data.interval].value,
        applicationFeeBps: env.PLATFORM_FEE_BPS,
      },
    });
    subscriptionId = subscription.id;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) {
      log.error("create subscription failed", {
        action: "createSubscription",
        userId: user.id,
        err,
      });
      redirect("/dashboard/subscriptions?error=create_failed");
    }
    // Same requestKey: this form was already submitted. Continue with the
    // subscription that submission created.
    const existing = await prisma.subscription.findFirst({
      where: { requestKey: parsed.data.requestKey, userId: user.id },
      select: { id: true },
    });
    if (!existing) {
      redirect("/dashboard/subscriptions?error=create_failed");
    }
    subscriptionId = existing.id;
  }

  let checkoutUrl: string;
  try {
    checkoutUrl = await getOrCreateSubscriptionLink(subscriptionId, user);
  } catch (err) {
    log.error("subscription saved but its checkout link failed", {
      action: "createSubscription",
      userId: user.id,
      subscriptionId,
      err,
    });
    redirect("/dashboard/subscriptions?error=link_pending");
  }

  linkRedirect(checkoutUrl);
}

export async function getSubscriptionLink(formData: FormData) {
  let user;
  try {
    user = await authorizeTenantAction();
  } catch (err) {
    redirectForTenantError(err, "/dashboard/subscriptions");
  }

  const subscriptionId = formData.get("subscriptionId");
  if (typeof subscriptionId !== "string") {
    redirect("/dashboard/subscriptions?error=invalid_input");
  }

  let checkoutUrl: string;
  try {
    checkoutUrl = await getOrCreateSubscriptionLink(subscriptionId, user);
  } catch (err) {
    if (err instanceof BillingError) {
      redirect(`/dashboard/subscriptions?error=${err.message}`);
    }
    log.error("get subscription link failed", {
      action: "getSubscriptionLink",
      userId: user.id,
      subscriptionId,
      err,
    });
    redirect("/dashboard/subscriptions?error=link_failed");
  }

  linkRedirect(checkoutUrl);
}

// Cancels in Stripe only. The row turns CANCELED when the worker processes
// Stripe's customer.subscription.deleted — see requestSubscriptionCancellation().
export async function cancelSubscription(formData: FormData) {
  let user;
  try {
    user = await authorizeTenantAction();
  } catch (err) {
    redirectForTenantError(err, "/dashboard/subscriptions");
  }

  const subscriptionId = formData.get("subscriptionId");
  if (typeof subscriptionId !== "string") {
    redirect("/dashboard/subscriptions?error=invalid_input");
  }

  try {
    await requestSubscriptionCancellation(subscriptionId, user);
  } catch (err) {
    if (err instanceof BillingError) {
      redirect(`/dashboard/subscriptions?error=${err.message}`);
    }
    log.error("cancel subscription failed", {
      action: "cancelSubscription",
      userId: user.id,
      subscriptionId,
      err,
    });
    redirect("/dashboard/subscriptions?error=cancel_failed");
  }

  redirect("/dashboard/subscriptions?notice=cancel_requested");
}

// Removes a subscription the customer never completed Checkout for.
export async function discardSubscription(formData: FormData) {
  let user;
  try {
    user = await authorizeTenantAction();
  } catch (err) {
    redirectForTenantError(err, "/dashboard/subscriptions");
  }

  const subscriptionId = formData.get("subscriptionId");
  if (typeof subscriptionId !== "string") {
    redirect("/dashboard/subscriptions?error=invalid_input");
  }

  try {
    await discardPendingSubscription(subscriptionId, user);
  } catch (err) {
    if (err instanceof BillingError) {
      redirect(`/dashboard/subscriptions?error=${err.message}`);
    }
    log.error("discard subscription failed", {
      action: "discardSubscription",
      userId: user.id,
      subscriptionId,
      err,
    });
    redirect("/dashboard/subscriptions?error=discard_failed");
  }

  redirect("/dashboard/subscriptions");
}
