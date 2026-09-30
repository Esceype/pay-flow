// Public on purpose: Checkout redirects the *payer* here — the tenant's own
// customer, who has no PayFlow account — so no auth() check. It shows no
// invoice data either: the payment's actual outcome is recorded from
// Stripe's webhook by the worker, never from this redirect (ADR-006).
export default function PaymentSuccessPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-3 px-4 text-center">
      <h1 className="text-2xl font-semibold">Thank you!</h1>
      <p className="text-sm text-neutral-600">
        Your payment was submitted. You&apos;ll receive a receipt from the merchant by email — you
        can close this page.
      </p>
    </main>
  );
}
