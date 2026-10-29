import type Stripe from "stripe";
import { prisma } from "./prisma";
import { stripe } from "./stripe";

// The bridge between our payments and Stripe's payment intents (ADR-011).
//
// A refund is made against a payment intent, and a refund names only its
// payment intent. Neither payment webhook PayFlow records payments from
// carries one in this API version — checkout.session.completed has
// `payment_intent: null`, and invoice.paid has no `payments` — so the link
// is looked up from Stripe when it is first needed, and then kept on the
// Transaction. Recording a payment stays a webhook-only, no-API-call path.
//
// Every Stripe call here is made on the tenant's connected account, and
// every database lookup is scoped to the tenant.

const idOf = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : (value?.id ?? null);

// Our payment -> its payment intent. For a refund requested in PayFlow.
export async function paymentIntentForPayment(
  paymentId: string,
  stripeAccountId: string
): Promise<string | null> {
  const payment = await prisma.transaction.findUniqueOrThrow({
    where: { id: paymentId },
    select: {
      stripePaymentIntentId: true,
      stripeInvoiceId: true,
      invoice: { select: { stripeCheckoutSessionId: true } },
    },
  });
  if (payment.stripePaymentIntentId) return payment.stripePaymentIntentId;

  const account = { stripeAccount: stripeAccountId };
  let paymentIntentId: string | null = null;

  if (payment.invoice?.stripeCheckoutSessionId) {
    // A one-time invoice: paid through its Checkout Session. A paid invoice
    // never gets a new session, so this is the one that was paid.
    const session = await stripe.checkout.sessions.retrieve(
      payment.invoice.stripeCheckoutSessionId,
      {},
      account
    );
    paymentIntentId = idOf(session.payment_intent);
  } else if (payment.stripeInvoiceId) {
    // A subscription payment: Stripe's invoice lists how it was paid.
    const invoicePayments = await stripe.invoicePayments.list(
      { invoice: payment.stripeInvoiceId, limit: 10 },
      account
    );
    const paid = invoicePayments.data.find(
      (invoicePayment) =>
        invoicePayment.status === "paid" && invoicePayment.payment.type === "payment_intent"
    );
    paymentIntentId = idOf(paid?.payment.payment_intent);
  }

  if (paymentIntentId) {
    await prisma.transaction.update({
      where: { id: paymentId },
      data: { stripePaymentIntentId: paymentIntentId },
    });
  }
  return paymentIntentId;
}

// A payment intent -> our payment, if we recorded one for this tenant. For
// a refund made outside PayFlow, which arrives knowing nothing else.
export async function paymentForPaymentIntent(
  userId: string,
  paymentIntentId: string,
  stripeAccountId: string
): Promise<{ id: string } | null> {
  const isPayment = { userId, refundId: null, amount: { gt: 0 } };

  const known = await prisma.transaction.findFirst({
    where: { ...isPayment, stripePaymentIntentId: paymentIntentId },
    select: { id: true },
  });
  if (known) return known;

  // Not linked yet: ask Stripe which of our payment sources it belongs to.
  const account = { stripeAccount: stripeAccountId };
  let payment: { id: string } | null = null;

  const invoicePayments = await stripe.invoicePayments.list(
    { payment: { type: "payment_intent", payment_intent: paymentIntentId }, limit: 1 },
    account
  );
  const stripeInvoiceId = idOf(invoicePayments.data[0]?.invoice as Stripe.Invoice | string | undefined);
  if (stripeInvoiceId) {
    payment = await prisma.transaction.findFirst({
      where: { ...isPayment, stripeInvoiceId },
      select: { id: true },
    });
  }

  if (!payment) {
    const sessions = await stripe.checkout.sessions.list(
      { payment_intent: paymentIntentId, limit: 1 },
      account
    );
    const sessionId = sessions.data[0]?.id;
    if (sessionId) {
      payment = await prisma.transaction.findFirst({
        where: { ...isPayment, invoice: { stripeCheckoutSessionId: sessionId } },
        select: { id: true },
      });
    }
  }

  if (payment) {
    await prisma.transaction.updateMany({
      where: { id: payment.id, stripePaymentIntentId: null },
      data: { stripePaymentIntentId: paymentIntentId },
    });
  }
  return payment;
}
