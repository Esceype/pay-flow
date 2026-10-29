"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { AMOUNT_PATTERN, toMinorUnits } from "@/lib/billing";
import { log } from "@/lib/logger";
import { RefundError, requestRefund, retryRefund } from "@/lib/refunds";
import { authorizeTenantAction, redirectForTenantError } from "@/lib/tenant";

const refundSchema = z.object({
  paymentId: z.string().min(1),
  // As typed, e.g. "5.00"; converted exactly, as everywhere else.
  amount: z.string().trim().regex(AMOUNT_PATTERN),
  // Per-render form token: a double-submit reuses the refund it created
  // instead of refunding twice.
  requestKey: z.string().uuid(),
});

// See the control-flow note in customers/actions.ts — redirect() must never
// be called from inside a try block whose own catch would swallow its
// internal throw.
export async function refundPayment(formData: FormData) {
  let user;
  try {
    user = await authorizeTenantAction();
  } catch (err) {
    redirectForTenantError(err, "/dashboard/payments");
  }

  const parsed = refundSchema.safeParse({
    paymentId: formData.get("paymentId"),
    amount: formData.get("amount"),
    requestKey: formData.get("requestKey"),
  });
  if (!parsed.success || toMinorUnits(parsed.data.amount) <= 0) {
    redirect("/dashboard/payments?error=invalid_input");
  }

  try {
    await requestRefund(
      {
        paymentId: parsed.data.paymentId,
        amount: toMinorUnits(parsed.data.amount),
        requestKey: parsed.data.requestKey,
      },
      user
    );
  } catch (err) {
    if (err instanceof RefundError) {
      redirect(`/dashboard/payments?error=${err.message}`);
    }
    log.error("refund request failed", {
      action: "refundPayment",
      userId: user.id,
      paymentId: parsed.data.paymentId,
      err,
    });
    redirect("/dashboard/payments?error=refund_failed");
  }

  redirect("/dashboard/payments?notice=refund_requested");
}

export async function retryPendingRefund(formData: FormData) {
  let user;
  try {
    user = await authorizeTenantAction();
  } catch (err) {
    redirectForTenantError(err, "/dashboard/payments");
  }

  const refundId = formData.get("refundId");
  if (typeof refundId !== "string") {
    redirect("/dashboard/payments?error=invalid_input");
  }

  try {
    await retryRefund(refundId, user);
  } catch (err) {
    if (err instanceof RefundError) {
      redirect(`/dashboard/payments?error=${err.message}`);
    }
    log.error("refund retry failed", { action: "retryPendingRefund", userId: user.id, refundId, err });
    redirect("/dashboard/payments?error=refund_failed");
  }

  redirect("/dashboard/payments?notice=refund_requested");
}
