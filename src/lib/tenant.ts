import { auth } from "./auth";
import { prisma } from "./prisma";
import type { User } from "@prisma/client";

export class TenantError extends Error {}

// Shared precondition for every Customer/Invoice action: caller must be
// signed in AND have finished Stripe Connect onboarding. Business actions
// (Customer creation touches the connected account's Stripe API; Invoice
// creation creates a real Checkout Session) are gated on
// onboardingComplete — see docs/adr/003-stripe-connect-multitenancy.md.
export async function requireOnboardedUser(): Promise<User & { stripeAccountId: string }> {
  const session = await auth();
  if (!session?.user) {
    throw new TenantError("not_authenticated");
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
  if (!user.onboardingComplete || !user.stripeAccountId) {
    throw new TenantError("stripe_not_connected");
  }

  return user as User & { stripeAccountId: string };
}
