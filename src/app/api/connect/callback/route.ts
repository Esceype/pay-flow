import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { syncConnectAccountStatus } from "@/lib/stripe-connect";

const STATE_COOKIE = "stripe_connect_state";

function toDashboard(error?: string) {
  const url = new URL("/dashboard", env.NEXTAUTH_URL);
  if (error) url.searchParams.set("connect_error", error);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.redirect(new URL("/login", env.NEXTAUTH_URL));
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const cookieStore = await cookies();
  const cookieState = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE);

  if (oauthError) {
    // User declined, or Stripe rejected the request — not a bug, just an
    // outcome to surface on the dashboard.
    return toDashboard(oauthError);
  }

  if (!code || !state || !cookieState || state !== cookieState) {
    return toDashboard("invalid_state");
  }

  let stripeAccountId: string | undefined;
  try {
    const tokenResponse = await stripe.oauth.token({ grant_type: "authorization_code", code });
    stripeAccountId = tokenResponse.stripe_user_id;
  } catch (err) {
    console.error("[connect callback] token exchange failed", err);
    return toDashboard("token_exchange_failed");
  }

  if (!stripeAccountId) {
    return toDashboard("missing_account_id");
  }

  try {
    await prisma.user.update({
      where: { id: session.user.id },
      // stripeConnectedAt: ordering guard for a later (or stale, queued)
      // account.application.deauthorized — see unlinkConnectAccount().
      data: { stripeAccountId, stripeConnectedAt: new Date() },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // That Stripe account is already linked to a different User.
      return toDashboard("account_already_linked");
    }
    throw err;
  }

  await syncConnectAccountStatus(stripeAccountId);

  return toDashboard();
}
