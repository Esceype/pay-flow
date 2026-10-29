import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Every /dashboard/* page renders through this layout, so the session
  // check here covers all of them — but per docs/adr/004-auth-and-proxy-gate.md,
  // each page/action still checks auth() itself too (defense in depth, not
  // relying on a single gate).
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <nav className="flex items-center justify-between border-b pb-4">
        <div className="flex gap-4 text-sm font-medium">
          <Link href="/dashboard" className="hover:underline">Dashboard</Link>
          <Link href="/dashboard/customers" className="hover:underline">Customers</Link>
          <Link href="/dashboard/invoices" className="hover:underline">Invoices</Link>
          <Link href="/dashboard/subscriptions" className="hover:underline">Subscriptions</Link>
          <Link href="/dashboard/payments" className="hover:underline">Payments</Link>
        </div>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button type="submit" className="text-sm text-neutral-600 underline">
            Sign out
          </button>
        </form>
      </nav>
      {children}
    </div>
  );
}
