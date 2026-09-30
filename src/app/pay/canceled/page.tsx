// Public, like /pay/success: the payer backed out of Checkout. The session
// stays open until it expires, so the same payment link still works.
export default function PaymentCanceledPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-3 px-4 text-center">
      <h1 className="text-2xl font-semibold">Payment canceled</h1>
      <p className="text-sm text-neutral-600">
        No payment was made. You can use the same payment link again whenever you&apos;re ready.
      </p>
    </main>
  );
}
