"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import { requireOnboardedUser, TenantError } from "@/lib/tenant";

const invoiceSchema = z.object({
  customerId: z.string().min(1),
  // Dollars as typed by the user (e.g. "19.99") — converted to integer
  // cents below, since Stripe and our own Invoice.amountDue are both cents.
  amount: z.coerce.number().positive(),
  currency: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{3}$/, "currency must be a 3-letter ISO code")
    .default("usd"),
});

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
    currency: formData.get("currency") || undefined,
  });
  if (!parsed.success) {
    redirect("/dashboard/invoices?error=invalid_input");
  }

  const customer = await prisma.customer.findFirst({
    where: { id: parsed.data.customerId, userId: user.id },
  });
  if (!customer?.stripeCustomerId) {
    redirect("/dashboard/invoices?error=invalid_customer");
  }

  const amountDue = Math.round(parsed.data.amount * 100);

  let checkoutUrl: string | null;
  try {
    // Checkout Session, not Stripe's native Invoicing API — this project
    // models "Invoice" as our own record tied to a one-time Checkout
    // Session (Invoice.stripeInvoiceId stays null), not Stripe's Invoice
    // object. Created on the connected account (stripeAccount), never the
    // platform.
    const checkoutSession = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer: customer.stripeCustomerId,
        line_items: [
          {
            price_data: {
              currency: parsed.data.currency,
              product_data: { name: `Invoice for ${customer.email}` },
              unit_amount: amountDue,
            },
            quantity: 1,
          },
        ],
        success_url: `${env.NEXTAUTH_URL}/dashboard/invoices?paid=1`,
        cancel_url: `${env.NEXTAUTH_URL}/dashboard/invoices?canceled=1`,
      },
      { stripeAccount: user.stripeAccountId }
    );

    await prisma.invoice.create({
      data: {
        customerId: customer.id,
        stripeCheckoutSessionId: checkoutSession.id,
        amountDue,
        currency: parsed.data.currency,
        status: "PENDING",
      },
    });

    checkoutUrl = checkoutSession.url;
  } catch (err) {
    console.error("[createInvoice] failed", err);
    redirect("/dashboard/invoices?error=create_failed");
  }

  redirect(`/dashboard/invoices?checkout_url=${encodeURIComponent(checkoutUrl ?? "")}`);
}

// Checkout Session URLs aren't stored (they're just re-derivable from
// Stripe, and storing a second copy of something Stripe already owns isn't
// worth it) — this re-fetches one for a still-PENDING invoice so it can be
// shared again after the create-time redirect display is gone.
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

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, customer: { userId: user.id } },
  });
  if (!invoice?.stripeCheckoutSessionId) {
    redirect("/dashboard/invoices?error=invalid_invoice");
  }

  let checkoutUrl: string | null;
  try {
    const checkoutSession = await stripe.checkout.sessions.retrieve(
      invoice.stripeCheckoutSessionId,
      {},
      { stripeAccount: user.stripeAccountId }
    );
    checkoutUrl = checkoutSession.url;
  } catch (err) {
    console.error("[getInvoiceLink] failed", err);
    redirect("/dashboard/invoices?error=link_failed");
  }

  redirect(`/dashboard/invoices?checkout_url=${encodeURIComponent(checkoutUrl ?? "")}`);
}
