import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CURRENCIES, isStripeCheckoutUrl } from "@/lib/billing";
import { createInvoice, getInvoiceLink } from "./actions";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_input: "Please fill in all fields with valid values (amount like 19.99).",
  rate_limited: "Too many requests — please wait a moment and try again.",
  amount_too_small: "That amount is below Stripe's minimum charge for this currency.",
  amount_too_large: "That amount is above the maximum for a single charge (999,999.99).",
  invalid_customer: "That customer couldn't be found.",
  invalid_invoice: "That invoice couldn't be found.",
  create_failed: "Couldn't create the invoice — please try again.",
  link_pending:
    "Invoice saved, but the payment link couldn't be created yet — use “Get payment link” to retry.",
  link_failed: "Couldn't retrieve the payment link — please try again.",
  not_payable: "That invoice is already paid or void.",
  already_completed: "That invoice's checkout is already completed — its payment is settling.",
  conflict: "The payment link was just regenerated elsewhere — please try again.",
  missing_url: "Stripe didn't return a payment link — please try again.",
};

const STATUS_STYLES: Record<string, string> = {
  PENDING: "text-amber-700",
  PAID: "text-green-700",
  FAILED: "text-red-700",
  EXPIRED: "text-neutral-500",
  VOID: "text-neutral-500",
};

// Statuses a (new) payment link can be issued for — see getOrCreatePaymentLink().
const LINKABLE_STATUSES = new Set(["PENDING", "EXPIRED", "FAILED"]);

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    checkout_url?: string;
    customerId?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const [params, user, customers, invoices] = await Promise.all([
    searchParams,
    prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { onboardingComplete: true },
    }),
    prisma.customer.findMany({
      where: { userId: session.user.id },
      orderBy: { email: "asc" },
    }),
    prisma.invoice.findMany({
      where: { userId: session.user.id },
      include: { customer: { select: { email: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const error = params.error ? (ERROR_MESSAGES[params.error] ?? "Something went wrong.") : null;
  const checkoutUrl =
    params.checkout_url && isStripeCheckoutUrl(params.checkout_url) ? params.checkout_url : null;

  if (!user.onboardingComplete) {
    return (
      <main className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Invoices</h1>
        <p className="text-sm text-neutral-600">
          Connect your Stripe account from the{" "}
          <a href="/dashboard" className="underline">Dashboard</a> before creating invoices.
        </p>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Invoices</h1>

      {error && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {checkoutUrl && (
        <div className="rounded border border-green-200 bg-green-50 p-4">
          <p className="text-sm font-medium text-green-800">Payment link ready — share this with the customer:</p>
          <a
            href={checkoutUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block break-all text-sm text-green-700 underline"
          >
            {checkoutUrl}
          </a>
          <p className="mt-2 text-xs text-green-800">
            The invoice flips to PAID once Stripe&apos;s webhook is processed by the worker —
            asynchronously, not as part of the customer&apos;s checkout redirect.
          </p>
        </div>
      )}

      {customers.length === 0 ? (
        <p className="text-sm text-neutral-600">
          Add a <a href="/dashboard/customers" className="underline">customer</a> before creating
          an invoice.
        </p>
      ) : (
        <form action={createInvoice} className="flex flex-wrap items-end gap-3 rounded border p-4">
          {/* Fresh per render: a double-submit of this same form reuses the
              invoice it created instead of adding a second one. */}
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
            Amount
            <input
              type="text"
              inputMode="decimal"
              name="amount"
              pattern="\d+(\.\d{1,2})?"
              required
              placeholder="19.99"
              className="rounded border px-3 py-2"
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
          <button
            type="submit"
            className="rounded bg-black px-3 py-2 text-sm text-white hover:bg-neutral-800"
          >
            Create invoice
          </button>
        </form>
      )}

      {invoices.length === 0 ? (
        <p className="text-sm text-neutral-600">No invoices yet.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-neutral-500">
              <th className="py-2 font-medium">Customer</th>
              <th className="py-2 font-medium">Amount</th>
              <th className="py-2 font-medium">Status</th>
              <th className="py-2 font-medium">Created</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => (
              <tr key={invoice.id} className="border-b">
                <td className="py-2">{invoice.customer.email}</td>
                <td className="py-2">
                  {(invoice.amountDue / 100).toFixed(2)} {invoice.currency.toUpperCase()}
                  {invoice.applicationFeeAmount > 0 && (
                    <span className="block text-xs text-neutral-500">
                      platform fee {(invoice.applicationFeeAmount / 100).toFixed(2)}
                    </span>
                  )}
                </td>
                <td className={`py-2 font-medium ${STATUS_STYLES[invoice.status] ?? ""}`}>
                  {invoice.status}
                </td>
                <td className="py-2">{invoice.createdAt.toLocaleDateString()}</td>
                <td className="py-2 text-right">
                  {LINKABLE_STATUSES.has(invoice.status) && (
                    <form action={getInvoiceLink} className="inline">
                      <input type="hidden" name="invoiceId" value={invoice.id} />
                      <button type="submit" className="underline">
                        {invoice.status === "PENDING" ? "Get payment link" : "New payment link"}
                      </button>
                    </form>
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
