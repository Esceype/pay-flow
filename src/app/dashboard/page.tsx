import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getRevenueStats } from "@/lib/revenue-stats";
import { syncConnectAccountStatus } from "@/lib/stripe-connect";

const formatMoney = (cents: number, currency: string) =>
  `${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency.toUpperCase()}`;

const CONNECT_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "You declined to connect your Stripe account.",
  invalid_state: "That connection attempt expired or was invalid — please try again.",
  token_exchange_failed: "Stripe couldn't confirm the connection — please try again.",
  missing_account_id: "Stripe didn't return an account id — please try again.",
  account_already_linked: "That Stripe account is already linked to a different user.",
  onboarding_link_failed:
    "Couldn't open Stripe's onboarding for this account — complete the outstanding requirements in your Stripe Dashboard, then come back.",
  status_sync_failed: "Couldn't refresh your Stripe account status — please reload in a moment.",
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ connect_error?: string }>;
}) {
  // Defense in depth: DashboardLayout already checks the session, but this
  // page checks it directly too (docs/adr/004-auth-and-proxy-gate.md).
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const params = await searchParams;
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: session.user.id },
    select: { email: true, stripeAccountId: true, onboardingComplete: true },
  });

  // Read-repair: account.updated (via the worker) is the primary way this
  // flag gets updated, but Stripe often finishes verifying an account a
  // little after the tenant returns from onboarding — and if that webhook
  // is delayed or never arrives (e.g. local dev without `stripe listen`),
  // the tenant would stay stuck here. Only in this linked-but-incomplete
  // state, so complete tenants never pay for a Stripe API call per page view.
  if (user.stripeAccountId && !user.onboardingComplete) {
    try {
      user.onboardingComplete =
        (await syncConnectAccountStatus(user.stripeAccountId)) ?? user.onboardingComplete;
    } catch (err) {
      // Best effort — the stored flag is still a valid (if stale) answer.
      console.error("[dashboard] Connect status read-repair failed", err);
    }
  }

  const connectError = params.connect_error
    ? (CONNECT_ERROR_MESSAGES[params.connect_error] ?? "Something went wrong connecting Stripe.")
    : null;

  // From the read model (Redis, then one indexed read of
  // MaterializedRevenueStats) — this page never aggregates Subscription or
  // Transaction itself. The worker keeps those figures current. ADR-002.
  const revenue = await getRevenueStats(session.user.id);

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="text-sm text-neutral-600">Signed in as {user.email}</p>

      {connectError && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {connectError}
        </p>
      )}

      <section className="rounded border p-4">
        <h2 className="font-medium">Stripe Connect</h2>
        {user.onboardingComplete ? (
          <p className="mt-2 text-sm text-green-700">
            ✅ Connected ({user.stripeAccountId}). Charges and onboarding are complete.
          </p>
        ) : user.stripeAccountId ? (
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-sm text-amber-700">
              Account {user.stripeAccountId} is linked, but Stripe hasn&apos;t confirmed
              onboarding is complete yet (details submission and/or charge capability
              pending).
            </p>
            {/* Not /api/connect/start: re-running OAuth only re-links the
                same account, it never collects the missing requirements. */}
            <a
              href="/api/connect/onboarding"
              className="w-fit rounded bg-black px-3 py-2 text-sm text-white hover:bg-neutral-800"
            >
              Finish Stripe onboarding
            </a>
          </div>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-sm text-neutral-600">
              Connect your Stripe account to start accepting payments.
            </p>
            <a
              href="/api/connect/start"
              className="w-fit rounded bg-black px-3 py-2 text-sm text-white hover:bg-neutral-800"
            >
              Connect Stripe
            </a>
          </div>
        )}
      </section>

      {(user.onboardingComplete || revenue.byCurrency.length > 0) && (
        <section className="rounded border p-4">
          <h2 className="font-medium">Revenue</h2>
          {revenue.byCurrency.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-600">
              No revenue yet — figures appear here after the first payment or subscription.
            </p>
          ) : (
            <table className="mt-2 w-full text-left text-sm">
              <thead>
                <tr className="border-b text-neutral-500">
                  <th className="py-2 font-medium">MRR</th>
                  <th className="py-2 font-medium">Active subscriptions</th>
                  <th className="py-2 font-medium">Churn (30 days)</th>
                  <th className="py-2 font-medium">Total revenue</th>
                </tr>
              </thead>
              <tbody>
                {revenue.byCurrency.map((stats) => (
                  <tr key={stats.currency} className="border-b">
                    <td className="py-2 font-medium">{formatMoney(stats.mrr, stats.currency)}</td>
                    <td className="py-2">{stats.activeSubscriptions}</td>
                    <td className="py-2">{(stats.churnRate * 100).toFixed(1)}%</td>
                    <td className="py-2">{formatMoney(stats.totalRevenue, stats.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-xs text-neutral-500">
            Updated in the background after each payment or subscription change, so it can trail
            the lists by a few seconds.
            {revenue.computedAt &&
              ` Computed ${revenue.computedAt.replace("T", " ").slice(0, 16)} UTC.`}
          </p>
        </section>
      )}

      {user.onboardingComplete && (
        <p className="text-sm text-neutral-600">
          Head to <a href="/dashboard/customers" className="underline">Customers</a> to add a
          customer and create your first invoice.
        </p>
      )}
    </main>
  );
}
