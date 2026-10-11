"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { ensureStripeCustomer } from "@/lib/billing";
import { authorizeTenantAction, redirectForTenantError } from "@/lib/tenant";

const customerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).optional(),
});

// Note on control flow: redirect() throws internally (that's how Next.js
// implements it), so it must never be called from inside a try block whose
// own catch would then swallow that throw as if it were a real error. Every
// action below only calls redirect() either from inside a catch block, or
// after the try/catch has already completed — never nested inside the try.
export async function createCustomer(formData: FormData) {
  let user;
  try {
    user = await authorizeTenantAction();
  } catch (err) {
    redirectForTenantError(err, "/dashboard/customers");
  }

  const parsed = customerSchema.safeParse({
    email: formData.get("email"),
    name: formData.get("name") || undefined,
  });
  if (!parsed.success) {
    redirect("/dashboard/customers?error=invalid_input");
  }

  // Intent-first: our row is written before anything happens in Stripe.
  // The (userId, email) unique constraint rejects a duplicate (or a
  // double-submitted form) here, before a Stripe customer could be created
  // for it — and the Stripe call below is keyed to this row's id.
  let customer;
  try {
    customer = await prisma.customer.create({
      data: { userId: user.id, email: parsed.data.email, name: parsed.data.name },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      redirect("/dashboard/customers?error=duplicate");
    }
    console.error("[createCustomer] failed", err);
    redirect("/dashboard/customers?error=create_failed");
  }

  try {
    await ensureStripeCustomer(customer, user);
  } catch (err) {
    // The customer is saved; only its Stripe counterpart is missing, and
    // ensureStripeCustomer() runs again (same idempotency key) before the
    // first invoice for it. Not worth failing the whole action over.
    console.error("[createCustomer] Stripe sync failed, will retry on first invoice", err);
    redirect("/dashboard/customers?error=stripe_sync_pending");
  }

  redirect("/dashboard/customers");
}

export async function deleteCustomer(formData: FormData) {
  let user;
  try {
    user = await authorizeTenantAction();
  } catch (err) {
    redirectForTenantError(err, "/dashboard/customers");
  }

  const customerId = formData.get("customerId");
  if (typeof customerId !== "string") {
    redirect("/dashboard/customers?error=invalid_input");
  }

  // Scoped to userId, not just the id — without this, any signed-in tenant
  // could delete another tenant's customer by guessing/reusing an id.
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, userId: user.id },
    include: { _count: { select: { invoices: true, subscriptions: true } } },
  });
  if (!customer) {
    redirect("/dashboard/customers");
  }
  // Billing history is never deleted as a side effect of removing a
  // customer. This check gives the friendly error; the Restrict foreign
  // keys on Invoice/Subscription are the backstop if an invoice is created
  // between this check and the delete below.
  if (customer._count.invoices > 0 || customer._count.subscriptions > 0) {
    redirect("/dashboard/customers?error=has_invoices");
  }

  // Local row first, Stripe second: if the local delete is refused (the FK
  // race above), the Stripe customer must still exist for those invoices.
  try {
    await prisma.customer.delete({ where: { id: customer.id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      redirect("/dashboard/customers?error=has_invoices");
    }
    console.error("[deleteCustomer] failed", err);
    redirect("/dashboard/customers?error=delete_failed");
  }

  if (customer.stripeCustomerId) {
    try {
      await stripe.customers.del(customer.stripeCustomerId, {}, { stripeAccount: user.stripeAccountId });
    } catch (err) {
      // Already gone in Stripe is the outcome we wanted. Anything else
      // leaves an orphan Stripe customer with no invoices — harmless, so
      // logged rather than surfaced; our side is already consistent.
      if ((err as { code?: string }).code !== "resource_missing") {
        console.error(`[deleteCustomer] Stripe customer ${customer.stripeCustomerId} not deleted`, err);
      }
    }
  }

  redirect("/dashboard/customers");
}
