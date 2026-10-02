import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";

// "Finish Stripe onboarding" for an account that is already linked but can't
// accept charges yet (outstanding requirements). Re-running the OAuth flow
// (/api/connect/start) only re-links the same account — it never asks for
// the missing details — so this sends the tenant to Stripe's hosted
// onboarding instead, which collects exactly what's outstanding.
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.redirect(new URL("/login", env.NEXTAUTH_URL));
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { stripeAccountId: true },
  });
  if (!user?.stripeAccountId) {
    // Nothing linked yet — that's the OAuth flow's job.
    return NextResponse.redirect(new URL("/api/connect/start", env.NEXTAUTH_URL));
  }

  try {
    // A platform-level call *about* the connected account (`account` param),
    // not a call made on its behalf — so no `stripeAccount` option here.
    const link = await stripe.accountLinks.create({
      account: user.stripeAccountId,
      type: "account_onboarding",
      // Stripe sends the tenant here if the single-use link expired or was
      // already visited; this route simply issues a fresh one.
      refresh_url: new URL("/api/connect/onboarding", env.NEXTAUTH_URL).toString(),
      // Returning doesn't mean onboarding is complete — /api/connect/return
      // re-reads the account's real status from Stripe.
      return_url: new URL("/api/connect/return", env.NEXTAUTH_URL).toString(),
    });
    return NextResponse.redirect(link.url);
  } catch (err) {
    // Stripe refuses Account Links for accounts the platform doesn't
    // control (a pre-existing Stripe account connected over OAuth): those
    // owners resolve requirements in their own Stripe Dashboard.
    console.error("[connect onboarding] account link failed", err);
    const url = new URL("/dashboard", env.NEXTAUTH_URL);
    url.searchParams.set("connect_error", "onboarding_link_failed");
    return NextResponse.redirect(url);
  }
}
