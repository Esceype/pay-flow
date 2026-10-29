import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import type { Refund } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { refundableAmount } from "@/lib/refund-state";
import { refundPayment, retryPendingRefund } from "./actions";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_input: "Please enter an amount like 5.00.",
  rate_limited: "Too many requests — please wait a moment and try again.",
  not_refundable: "That payment can't be refunded.",
  exceeds_refundable: "That is more than is left to refund on this payment.",
  no_payment_intent: "Stripe has no record of how this payment was made, so it can't be refunded here.",
  rejected: "Stripe declined the refund — see the reason under the payment.",
  unavailable:
    "Stripe couldn't be reached, so the refund isn't confirmed. It is kept as pending — use Retry.",
  not_found: "That refund couldn't be found.",
  not_retryable: "That refund has already reached Stripe.",
  refund_failed: "Something went wrong requesting the refund — please try again.",
};

const NOTICE_MESSAGES: Record<string, string> = {
  refund_requested:
    "Refund sent to Stripe. It shows as succeeded here once Stripe's webhook confirms it.",
};

const STATUS_STYLES: Record<string, string> = {
  PENDING: "text-amber-700",
  SUCCEEDED: "text-green-700",
  FAILED: "text-red-700",
  CANCELED: "text-neutral-500",
};

const formatMoney = (cents: number, currency: string) =>
  `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;

// A refund PayFlow asked for but Stripe never answered: nothing in Stripe
// says it exists, and only asking again settles it.
const awaitingStripe = (refund: Refund) =>
  refund.status === "PENDING" && !refund.stripeRefundId && refund.requestKey !== null;

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const [params, user, payments] = await Promise.all([
    searchParams,
    prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { onboardingComplete: true },
    }),
    // Payments only — the ledger's refund rows are shown under the payment
    // they refund. Newest first, through the (userId, createdAt) index.
    prisma.transaction.findMany({
      where: { userId: session.user.id, refundId: null, amount: { gt: 0 } },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        invoice: { select: { customer: { select: { email: true } } } },
        subscription: { select: { customer: { select: { email: true } } } },
        refunds: { orderBy: { createdAt: "asc" } },
      },
    }),
  ]);

  const error = params.error ? (ERROR_MESSAGES[params.error] ?? "Something went wrong.") : null;
  const notice = params.notice ? (NOTICE_MESSAGES[params.notice] ?? null) : null;

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Payments</h1>

      {error && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded bg-neutral-50 px-3 py-2 text-sm text-neutral-700">{notice}</p>
      )}

      {payments.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No payments yet. Paid invoices and subscription payments appear here.
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-neutral-500">
              <th className="py-2 font-medium">Paid</th>
              <th className="py-2 font-medium">For</th>
              <th className="py-2 font-medium">Amount</th>
              <th className="py-2 font-medium">Refunds</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {payments.map((payment) => {
              const customer =
                payment.invoice?.customer.email ?? payment.subscription?.customer.email ?? "—";
              const refundable = refundableAmount(payment.amount, payment.refunds);
              return (
                <tr key={payment.id} className="border-b align-top">
                  <td className="py-2">{payment.createdAt.toLocaleDateString()}</td>
                  <td className="py-2">
                    {payment.subscriptionId ? "Subscription" : "Invoice"}
                    <span className="block text-xs text-neutral-500">{customer}</span>
                  </td>
                  <td className="py-2">{formatMoney(payment.amount, payment.currency)}</td>
                  <td className="py-2">
                    {payment.refunds.length === 0 ? (
                      <span className="text-neutral-400">—</span>
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {payment.refunds.map((refund) => (
                          <li key={refund.id}>
                            <span className={`font-medium ${STATUS_STYLES[refund.status] ?? ""}`}>
                              −{formatMoney(refund.amount, refund.currency)} {refund.status}
                            </span>
                            <span className="block text-xs text-neutral-500">
                              {refund.requestKey ? "from PayFlow" : "made in Stripe"}
                              {refund.failureReason && ` · ${refund.failureReason}`}
                            </span>
                            {awaitingStripe(refund) && (
                              <form action={retryPendingRefund} className="text-xs">
                                <input type="hidden" name="refundId" value={refund.id} />
                                not confirmed by Stripe ·{" "}
                                <button type="submit" className="underline">
                                  Retry
                                </button>
                              </form>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    {user.onboardingComplete && refundable > 0 && (
                      <form action={refundPayment} className="flex items-center justify-end gap-2">
                        <input type="hidden" name="paymentId" value={payment.id} />
                        {/* Fresh per render: a double-submit of this form
                            reuses the refund it created. */}
                        <input type="hidden" name="requestKey" value={randomUUID()} />
                        <input
                          type="text"
                          inputMode="decimal"
                          name="amount"
                          pattern="\d+(\.\d{1,2})?"
                          required
                          defaultValue={(refundable / 100).toFixed(2)}
                          aria-label="Amount to refund"
                          className="w-24 rounded border px-2 py-1"
                        />
                        <button type="submit" className="text-red-700 underline">
                          Refund
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {payments.length === 50 && (
        <p className="text-xs text-neutral-500">Showing the 50 most recent payments.</p>
      )}
    </main>
  );
}
