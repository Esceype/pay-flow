"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  AMOUNT_PATTERN,
  applicationFeeFor,
  BillingError,
  CURRENCIES,
  getOrCreatePaymentLink,
  MAX_AMOUNT,
  toMinorUnits,
  type Currency,
} from "@/lib/billing";
import { requireOnboardedUser, TenantError } from "@/lib/tenant";

const invoiceSchema = z.object({
  customerId: z.string().min(1),
  // Dollars as typed (e.g. "19.99"), parsed as a string rather than a float
  // so the cents conversion below is exact.
  amount: z.string().trim().regex(AMOUNT_PATTERN),
  currency: z.enum(Object.keys(CURRENCIES) as [Currency, ...Currency[]]),
  // Per-render form token (see page.tsx): makes the create request itself
  // idempotent — a double-submit reuses the invoice instead of adding one.
  requestKey: z.string().uuid(),
});

function linkRedirect(checkoutUrl: string): never {
  redirect(`/dashboard/invoices?checkout_url=${encodeURIComponent(checkoutUrl)}`);
}

// See the control-flow note in customers/actions.ts — same rule applies
// here: redirect() must never be called from inside a try block whose own
// catch would swallow its internal throw.
export async function createInvoice(formData: FormData) {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch (err) {
    redirect(err instanceof TenantError && err.message === "not_authenticated" ? "/login" : "/dashboard");
  }

  const parsed = invoiceSchema.safeParse({
    customerId: formData.get("customerId"),
    amount: formData.get("amount"),
    currency: formData.get("currency"),
    requestKey: formData.get("requestKey"),
  });
  if (!parsed.success) {
    redirect("/dashboard/invoices?error=invalid_input");
  }

  const amountDue = toMinorUnits(parsed.data.amount);
  if (amountDue < CURRENCIES[parsed.data.currency].minAmount) {
    redirect("/dashboard/invoices?error=amount_too_small");
  }
  if (amountDue > MAX_AMOUNT) {
    redirect("/dashboard/invoices?error=amount_too_large");
  }

  const customer = await prisma.customer.findFirst({
    where: { id: parsed.data.customerId, userId: user.id },
    select: { id: true },
  });
  if (!customer) {
    redirect("/dashboard/invoices?error=invalid_customer");
  }

  // Intent-first (ADR-006): the invoice row exists before any Stripe call,
  // so its id can key the Checkout Session idempotently, and a failure
  // after this point leaves a PENDING invoice whose link can be retried —
  // never a Stripe session that nothing in our database points to.
  let invoiceId: string;
  try {
    const invoice = await prisma.invoice.create({
      data: {
        customerId: customer.id,
        userId: user.id,
        requestKey: parsed.data.requestKey,
        amountDue,
        currency: parsed.data.currency,
        applicationFeeAmount: applicationFeeFor(amountDue),
        status: "PENDING",
      },
    });
    invoiceId = invoice.id;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) {
      console.error("[createInvoice] failed", err);
      redirect("/dashboard/invoices?error=create_failed");
    }
    // Same requestKey: this form was already submitted (double-click, or a
    // retry after a slow response). Continue with the invoice it created.
    const existing = await prisma.invoice.findFirst({
      where: { requestKey: parsed.data.requestKey, userId: user.id },
      select: { id: true },
    });
    if (!existing) {
      redirect("/dashboard/invoices?error=create_failed");
    }
    invoiceId = existing.id;
  }

  let checkoutUrl: string;
  try {
    checkoutUrl = await getOrCreatePaymentLink(invoiceId, user);
  } catch (err) {
    console.error("[createInvoice] payment link failed", err);
    redirect("/dashboard/invoices?error=link_pending");
  }

  linkRedirect(checkoutUrl);
}

// Checkout Session URLs aren't stored (they're re-derivable from Stripe,
// and storing a second copy of something Stripe already owns isn't worth
// it). This returns the open session's URL, or issues a new session if the
// previous one expired or its async payment failed.
export async function getInvoiceLink(formData: FormData) {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch (err) {
    redirect(err instanceof TenantError && err.message === "not_authenticated" ? "/login" : "/dashboard");
  }

  const invoiceId = formData.get("invoiceId");
  if (typeof invoiceId !== "string") {
    redirect("/dashboard/invoices?error=invalid_input");
  }

  let checkoutUrl: string;
  try {
    checkoutUrl = await getOrCreatePaymentLink(invoiceId, user);
  } catch (err) {
    if (err instanceof BillingError) {
      redirect(`/dashboard/invoices?error=${err.message}`);
    }
    console.error("[getInvoiceLink] failed", err);
    redirect("/dashboard/invoices?error=link_failed");
  }

  linkRedirect(checkoutUrl);
}
