import { prisma } from "./prisma";
import { stripe } from "./stripe";
import { env } from "./env";

export function getConnectRedirectUri(): string {
  return new URL("/api/connect/callback", env.NEXTAUTH_URL).toString();
}

// Single source of truth for turning a Stripe Connect Account object into
// our `onboardingComplete` flag. Called from two places: the OAuth callback
// (for immediate UX right after the user authorizes, without waiting on a
// webhook round trip) and the platform `account.updated` webhook handler
// (the ongoing sync mechanism for status changes after that point) — see
// docs/adr/003-stripe-connect-multitenancy.md.
export async function syncConnectAccountStatus(stripeAccountId: string) {
  const account = await stripe.accounts.retrieve(stripeAccountId);
  const onboardingComplete = Boolean(account.details_submitted && account.charges_enabled);

  // updateMany, not update: stripeAccountId may not match any User (e.g. an
  // event for an account we don't recognize) — that should be a no-op, not
  // a thrown P2025.
  await prisma.user.updateMany({
    where: { stripeAccountId },
    data: { onboardingComplete },
  });

  return onboardingComplete;
}
