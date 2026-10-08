import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createCustomer, deleteCustomer } from "./actions";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_input: "Please provide a valid email.",
  duplicate: "That email is already a customer.",
  create_failed: "Couldn't create the customer — please try again.",
  stripe_sync_pending:
    "Customer saved, but not yet registered on your Stripe account — this is retried automatically when you create their first invoice.",
  delete_failed: "Couldn't delete the customer — please try again.",
  has_invoices:
    "Customers with invoices or subscriptions can't be deleted — billing history is kept.",
};

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const [params, user, customers] = await Promise.all([
    searchParams,
    prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { onboardingComplete: true },
    }),
    prisma.customer.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { invoices: true, subscriptions: true } } },
    }),
  ]);

  const error = params.error ? (ERROR_MESSAGES[params.error] ?? "Something went wrong.") : null;

  if (!user.onboardingComplete) {
    return (
      <main className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Customers</h1>
        <p className="text-sm text-neutral-600">
          Connect your Stripe account from the{" "}
          <a href="/dashboard" className="underline">Dashboard</a> before adding customers —
          creating a customer registers it on your connected Stripe account.
        </p>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Customers</h1>

      {error && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <form action={createCustomer} className="flex flex-wrap items-end gap-3 rounded border p-4">
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input type="email" name="email" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Name (optional)
          <input name="name" className="rounded border px-3 py-2" />
        </label>
        <button
          type="submit"
          className="rounded bg-black px-3 py-2 text-sm text-white hover:bg-neutral-800"
        >
          Add customer
        </button>
      </form>

      {customers.length === 0 ? (
        <p className="text-sm text-neutral-600">No customers yet.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-neutral-500">
              <th className="py-2 font-medium">Email</th>
              <th className="py-2 font-medium">Name</th>
              <th className="py-2 font-medium">Added</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {customers.map((customer) => (
              <tr key={customer.id} className="border-b">
                <td className="py-2">{customer.email}</td>
                <td className="py-2">{customer.name ?? "—"}</td>
                <td className="py-2">{customer.createdAt.toLocaleDateString()}</td>
                <td className="py-2 text-right">
                  <a
                    href={`/dashboard/invoices?customerId=${customer.id}`}
                    className="mr-3 underline"
                  >
                    New invoice
                  </a>
                  <a
                    href={`/dashboard/subscriptions?customerId=${customer.id}`}
                    className="mr-3 underline"
                  >
                    New subscription
                  </a>
                  {customer._count.invoices === 0 && customer._count.subscriptions === 0 && (
                    <form action={deleteCustomer} className="inline">
                      <input type="hidden" name="customerId" value={customer.id} />
                      <button type="submit" className="text-red-700 underline">
                        Delete
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
