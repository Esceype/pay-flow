import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn } from "@/lib/auth";
import { clientAddress, consumeRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

const ERROR_MESSAGES: Record<string, string> = {
  CredentialsSignin: "Invalid email or password.",
  RateLimited: "Too many login attempts — please wait a minute and try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const params = await searchParams;
  const callbackUrl = params.callbackUrl ?? "/dashboard";

  async function login(formData: FormData) {
    "use server";
    const redirectTo = (formData.get("callbackUrl") as string) || "/dashboard";

    // Per client address, checked before the (deliberately slow) password
    // comparison: caps password guessing and the CPU it would cost.
    const limit = await consumeRateLimit(RATE_LIMITS.login, clientAddress(await headers()));
    if (!limit.allowed) {
      redirect(`/login?error=RateLimited&callbackUrl=${encodeURIComponent(redirectTo)}`);
    }

    try {
      await signIn("credentials", {
        email: formData.get("email"),
        password: formData.get("password"),
        redirectTo,
      });
    } catch (error) {
      // signIn's own successful-redirect throw is NOT an AuthError — it
      // must fall through to `throw error` so Next.js can still perform it.
      if (error instanceof AuthError) {
        redirect(
          `/login?error=CredentialsSignin&callbackUrl=${encodeURIComponent(redirectTo)}`
        );
      }
      throw error;
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <h1 className="text-2xl font-semibold">Log in</h1>
      {params.error && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {ERROR_MESSAGES[params.error] ?? ERROR_MESSAGES.CredentialsSignin}
        </p>
      )}
      <form action={login} className="flex flex-col gap-4">
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            type="email"
            name="email"
            required
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            type="password"
            name="password"
            required
            className="rounded border px-3 py-2"
          />
        </label>
        <button
          type="submit"
          className="rounded bg-black px-3 py-2 text-white hover:bg-neutral-800"
        >
          Log in
        </button>
      </form>
      <p className="text-sm text-neutral-600">
        No account? <Link href="/signup" className="underline">Sign up</Link>
      </p>
    </main>
  );
}
