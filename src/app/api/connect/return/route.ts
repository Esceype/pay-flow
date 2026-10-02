import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { syncConnectAccountStatus } from "@/lib/stripe-connect";

// Where Stripe's hosted onboarding (/api/connect/onboarding) sends the
// tenant back. Syncs onboardingComplete right away so the dashboard is
// correct on arrival — the account.updated webhook does the same through
// the worker, but may land a moment later (or not at all in local dev
// without `stripe listen`).
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.redirect(new URL("/login", env.NEXTAUTH_URL));
  }

  const dashboard = new URL("/dashboard", env.NEXTAUTH_URL);

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { stripeAccountId: true },
  });
  if (user?.stripeAccountId) {
    try {
      await syncConnectAccountStatus(user.stripeAccountId);
    } catch (err) {
      console.error("[connect return] status sync failed", err);
      dashboard.searchParams.set("connect_error", "status_sync_failed");
    }
  }

  return NextResponse.redirect(dashboard);
}
