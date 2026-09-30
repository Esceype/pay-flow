import { prisma } from "./prisma";
import { stripe } from "./stripe";
import { env } from "./env";

export function getConnectRedirectUri(): string {
  return new URL("/api/connect/callback", env.NEXTAUTH_URL).toString();
}

// Single source of truth for turning a Stripe Connect Account object into
// our `onboardingComplete` flag. Called from two places: the OAuth callback
// (for immediate UX right after the user authorizes, without waiting on a
// webhook round trip) and the worker's account.updated processor (the
// ongoing sync mechanism after that point) — see
// docs/adr/003-stripe-connect-multitenancy.md.
//
// Re-reads the account from Stripe instead of trusting the event payload:
// whichever account.updated job runs last writes the *current* state, so
// out-of-order processing can't regress the flag — no ordering guard needed.
export async function syncConnectAccountStatus(stripeAccountId: string): Promise<boolean | null> {
  // Checked before calling Stripe: an account we don't (or no longer) have
  // linked — e.g. an account.updated still queued behind a processed
  // deauthorization — would fail the retrieve with a permission error and
  // burn every retry. Nothing to sync for it, so no-op.
  const linked = await prisma.user.findUnique({
    where: { stripeAccountId },
    select: { id: true },
  });
  if (!linked) return null;

  const account = await stripe.accounts.retrieve(stripeAccountId);
  const onboardingComplete = Boolean(account.details_submitted && account.charges_enabled);

  // updateMany, not update: the link may have been removed between the
  // check above and here — that should be a no-op, not a thrown P2025.
  await prisma.user.updateMany({
    where: { stripeAccountId },
    data: { onboardingComplete },
  });

  return onboardingComplete;
}

// account.application.deauthorized: the tenant disconnected PayFlow from
// their Stripe account. Unlink it so the UI stops offering actions that
// would now fail against Stripe.
//
// Ordering guard: only a deauthorization that happened AFTER the current
// link was made may remove it. If the tenant disconnected and reconnected
// quickly, the queued deauthorization is stale and must not wipe the new
// connection. Compares Stripe's event.created with our own
// stripeConnectedAt — two different clocks, but reconnecting takes a full
// OAuth round trip, which dwarfs any realistic skew. Returns whether a
// link was actually removed.
export async function unlinkConnectAccount(
  stripeAccountId: string,
  deauthorizedAt: Date
): Promise<boolean> {
  const { count } = await prisma.user.updateMany({
    where: { stripeAccountId, stripeConnectedAt: { lt: deauthorizedAt } },
    data: { stripeAccountId: null, stripeConnectedAt: null, onboardingComplete: false },
  });
  return count > 0;
}
