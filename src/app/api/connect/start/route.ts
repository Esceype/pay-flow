import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import { getConnectRedirectUri } from "@/lib/stripe-connect";

const STATE_COOKIE = "stripe_connect_state";

export async function GET() {
  // Defense in depth: proxy.ts already gates /api/connect/*, but a route
  // move or matcher edit could silently drop that coverage (see the
  // warning in Next's own proxy docs) — check the session here too.
  const session = await auth();
  if (!session?.user) {
    return NextResponse.redirect(new URL("/login", env.NEXTAUTH_URL));
  }

  if (!env.STRIPE_CONNECT_CLIENT_ID) {
    return new Response("STRIPE_CONNECT_CLIENT_ID is not configured", { status: 500 });
  }

  // CSRF protection for the OAuth round trip: bound to a short-lived,
  // httpOnly cookie and checked again in the callback.
  const state = randomBytes(24).toString("hex");

  const authorizeUrl = stripe.oauth.authorizeUrl({
    response_type: "code",
    client_id: env.STRIPE_CONNECT_CLIENT_ID,
    scope: "read_write",
    redirect_uri: getConnectRedirectUri(),
    state,
  });

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10,
    path: "/",
  });
  return response;
}
