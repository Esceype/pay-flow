"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { requireOnboardedUser, TenantError } from "@/lib/tenant";

const customerSchema = z.object({
  email: z.string().email(),
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
    user = await requireOnboardedUser();
  } catch (err) {
    redirect(err instanceof TenantError && err.message === "not_authenticated" ? "/login" : "/dashboard");
  }

  const parsed = customerSchema.safeParse({
    email: formData.get("email"),
    name: formData.get("name") || undefined,
  });
  if (!parsed.success) {
    redirect("/dashboard/customers?error=invalid_input");
  }

  try {
    // Created on the connected account, not the platform — every Stripe
    // call made on a tenant's behalf must pass stripeAccount explicitly
    // (docs/adr/003-stripe-connect-multitenancy.md).
    const stripeCustomer = await stripe.customers.create(
      { email: parsed.data.email, name: parsed.data.name },
      { stripeAccount: user.stripeAccountId }
    );

    await prisma.customer.create({
      data: {
        userId: user.id,
        email: parsed.data.email,
        name: parsed.data.name,
        stripeCustomerId: stripeCustomer.id,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      redirect("/dashboard/customers?error=duplicate");
    }
    console.error("[createCustomer] failed", err);
    redirect("/dashboard/customers?error=create_failed");
  }

  redirect("/dashboard/customers");
}

export async function deleteCustomer(formData: FormData) {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch (err) {
    redirect(err instanceof TenantError && err.message === "not_authenticated" ? "/login" : "/dashboard");
  }

  const customerId = formData.get("customerId");
  if (typeof customerId !== "string") {
    redirect("/dashboard/customers?error=invalid_input");
  }

  try {
    // Scoped to userId, not just the id — without this, any signed-in
    // tenant could delete any other tenant's customer by guessing/reusing
    // an id. deleteMany rather than delete: a no-match (wrong tenant, or
    // already deleted) is a silent no-op instead of a thrown P2025.
    await prisma.customer.deleteMany({ where: { id: customerId, userId: user.id } });
  } catch (err) {
    console.error("[deleteCustomer] failed", err);
    redirect("/dashboard/customers?error=delete_failed");
  }

  redirect("/dashboard/customers");
}
