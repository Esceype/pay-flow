import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import type { BillingInterval } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CURRENCIES, INTERVALS, isStripeCheckoutUrl } from "@/lib/billing";
import { isTerminal } from "@/lib/subscription-state";
import {
  cancelSubscription,
  createSubscription,
  discardSubscription,
  getSubscriptionLink,
} from "./actions";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_input: "Please fill in all fields with valid values (amount like 29.00).",
  rate_limited: "Too many requests — please wait a moment and try again.",
  amount_too_small: "That amount is below Stripe's minimum charge for this currency.",
  amount_too_large: "That amount is above the maximum for a single charge (999,999.99).",
  invalid_customer: "That customer couldn't be found.",
  invalid_subscription: "That subscription couldn't be found.",
  create_failed: "Couldn't create the subscription — please try again.",
  link_pending:
    "Subscription saved, but the checkout link couldn't be created yet — use “Get checkout link” to retry.",
  link_failed: "Couldn't retrieve the checkout link — please try again.",
  not_awaiting_checkout: "That subscription has already been started — there is no checkout link for it.",
  already_completed:
    "The customer has already completed checkout — the subscription will show as active in a moment.",
  conflict: "The checkout link was just regenerated elsewhere — please try again.",
  missing_url: "Stripe didn't return a checkout link — please try again.",
  not_cancelable: "That subscription can't be canceled (it hasn't started, or has already ended).",
  cancel_failed: "Couldn't cancel the subscription — please try again.",
  not_discardable: "Only subscriptions still awaiting checkout can be discarded.",
  discard_failed: "Couldn't discard the subscription — please try again.",
};

const NOTICE_MESSAGES: Record<string, string> = {
  cancel_requested:
    "Cancellation sent to Stripe. The status changes to CANCELED here once Stripe's webhook confirms it.",
};

const STATUS_STYLES: Record<string, string> = {
  AWAITING_CHECKOUT: "text-amber-700",
  INCOMPLETE: "text-amber-700",
  TRIALING: "text-green-700",
  ACTIVE: "text-green-700",
  PAST_DUE: "text-red-700",
  UNPAID: "text-red-700",
  PAUSED: "text-neutral-500",
  INCOMPLETE_EXPIRED: "text-neutral-500",
  CANCELED: "text-neutral-500",
};

function formatPrice(
  amount: number,
  currency: string,
  interval: BillingInterval,
  intervalCount: number
) {
  const unit = interval.toLowerCase();
  const period = intervalCount === 1 ? unit : `${intervalCount} ${unit}s`;
  return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()} / ${period}`;
}

export default async function SubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    notice?: string;
    checkout_url?: string;
    customerId?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const [params, user, customers, subscriptions] = await Promise.all([
    searchParams,
    prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { onboardingComplete: true },
    }),
    prisma.customer.findMany({
      where: { userId: session.user.id },
      orderBy: { email: "asc" },
    }),
    prisma.subscription.findMany({
      where: { userId: session.user.id },
      include: { customer: { select: { email: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const error = params.error ? (ERROR_MESSAGES[params.error] ?? "Something went wrong.") : null;
  const notice = params.notice ? (NOTICE_MESSAGES[params.notice] ?? null) : null;
  const checkoutUrl =
    params.checkout_url && isStripeCheckoutUrl(params.checkout_url) ? params.checkout_url : null;

  if (!user.onboardingComplete) {
    return (
      <main className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Subscriptions</h1>
        <p className="text-sm text-neutral-600">
          Connect your Stripe account from the{" "}
          <a href="/dashboard" className="underline">Dashboard</a> before creating subscriptions.
        </p>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Subscriptions</h1>

      {error && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded bg-neutral-50 px-3 py-2 text-sm text-neutral-700">{notice}</p>
      )}
      {checkoutUrl && (
        <div className="rounded border border-green-200 bg-green-50 p-4">
          <p className="text-sm font-medium text-green-800">
            Checkout link ready — share this with the customer:
          </p>
          <a
            href={checkoutUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block break-all text-sm text-green-700 underline"
          >
            {checkoutUrl}
          </a>
          <p className="mt-2 text-xs text-green-800">
            The subscription starts when the customer completes checkout. Its status here is
            updated by the worker from Stripe&apos;s webhooks, not by the checkout redirect.
          </p>
        </div>
      )}

      {customers.length === 0 ? (
        <p className="text-sm text-neutral-600">
          Add a <a href="/dashboard/customers" className="underline">customer</a> before creating
          a subscription.
        </p>
      ) : (
        <form
          action={createSubscription}
          className="flex flex-wrap items-end gap-3 rounded border p-4"
        >
          {/* Fresh per render: a double-submit of this same form reuses the
              subscription it created instead of adding a second one. */}
          <input type="hidden" name="requestKey" value={randomUUID()} />
          <label className="flex flex-col gap-1 text-sm">
            Customer
            <select
              name="customerId"
              required
              defaultValue={params.customerId ?? ""}
              className="rounded border px-3 py-2"
            >
              <option value="" disabled>Select a customer</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.email}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Price
            <input
              type="text"
              inputMode="decimal"
              name="amount"
              pattern="\d+(\.\d{1,2})?"
              required
              placeholder="29.00"
              className="w-28 rounded border px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Currency
            <select name="currency" defaultValue="usd" className="rounded border px-3 py-2">
              {Object.entries(CURRENCIES).map(([code, { label }]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Billed
            <select name="interval" defaultValue="month" className="rounded border px-3 py-2">
              {Object.entries(INTERVALS).map(([code, { label }]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded bg-black px-3 py-2 text-sm text-white hover:bg-neutral-800"
          >
            Create subscription
          </button>
        </form>
      )}

      {subscriptions.length === 0 ? (
        <p className="text-sm text-neutral-600">No subscriptions yet.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-neutral-500">
              <th className="py-2 font-medium">Customer</th>
              <th className="py-2 font-medium">Price</th>
              <th className="py-2 font-medium">Status</th>
              <th className="py-2 font-medium">Current period ends</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {subscriptions.map((subscription) => (
              <tr key={subscription.id} className="border-b">
                <td className="py-2">{subscription.customer.email}</td>
                <td className="py-2">
                  {formatPrice(
                    subscription.amount,
                    subscription.currency,
                    subscription.interval,
                    subscription.intervalCount
                  )}
                </td>
                <td className={`py-2 font-medium ${STATUS_STYLES[subscription.status] ?? ""}`}>
                  {subscription.status.replaceAll("_", " ")}
                  {subscription.cancelAtPeriodEnd && !isTerminal(subscription.status) && (
                    <span className="block text-xs font-normal text-neutral-500">
                      cancels at period end
                    </span>
                  )}
                </td>
                <td className="py-2">
                  {subscription.currentPeriodEnd?.toLocaleDateString() ?? "—"}
                </td>
                <td className="py-2 text-right">
                  {subscription.status === "AWAITING_CHECKOUT" ? (
                    <>
                      <form action={getSubscriptionLink} className="mr-3 inline">
                        <input type="hidden" name="subscriptionId" value={subscription.id} />
                        <button type="submit" className="underline">
                          Get checkout link
                        </button>
                      </form>
                      <form action={discardSubscription} className="inline">
                        <input type="hidden" name="subscriptionId" value={subscription.id} />
                        <button type="submit" className="text-red-700 underline">
                          Discard
                        </button>
                      </form>
                    </>
                  ) : (
                    !isTerminal(subscription.status) && (
                      <form action={cancelSubscription} className="inline">
                        <input type="hidden" name="subscriptionId" value={subscription.id} />
                        <button type="submit" className="text-red-700 underline">
                          Cancel
                        </button>
                      </form>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
