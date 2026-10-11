import { redirect } from "next/navigation";
import type { User } from "@prisma/client";
import { auth } from "./auth";
import { prisma } from "./prisma";
import { consumeRateLimit, RATE_LIMITS } from "./rate-limit";

export class TenantError extends Error {}

// Shared entry check for every dashboard mutation (the server actions for
// customers, invoices and subscriptions). The caller must be:
//
//   1. signed in;
//   2. within their rate limit — checked before the database is touched,
//      so a client being throttled doesn't cost a query per rejection;
//   3. finished with Stripe Connect onboarding. Business actions create
//      real objects on the tenant's connected account and are gated on
//      onboardingComplete — docs/adr/003-stripe-connect-multitenancy.md.
export async function authorizeTenantAction(): Promise<User & { stripeAccountId: string }> {
  const session = await auth();
  if (!session?.user) {
    throw new TenantError("not_authenticated");
  }

  const limit = await consumeRateLimit(RATE_LIMITS.tenantAction, session.user.id);
  if (!limit.allowed) {
    throw new TenantError("rate_limited");
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
  if (!user.onboardingComplete || !user.stripeAccountId) {
    throw new TenantError("stripe_not_connected");
  }

  return user as User & { stripeAccountId: string };
}

// Where a server action sends the user when authorizeTenantAction() throws.
// `page` is the action's own page, so a throttled user stays where they
// were, with a message. Call it from the catch block only: redirect()
// works by throwing (see the note in customers/actions.ts).
export function redirectForTenantError(err: unknown, page: string): never {
  const reason = err instanceof TenantError ? err.message : null;
  if (reason === "not_authenticated") redirect("/login");
  if (reason === "rate_limited") redirect(`${page}?error=rate_limited`);
  redirect("/dashboard");
}
