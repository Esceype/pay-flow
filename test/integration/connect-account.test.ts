import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { createTenant } from "../db";
import { at, stripeEvent, T } from "../stripe-events";
import { processEvent } from "../worker";

const reload = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });

function accountUpdated(account: string) {
  return stripeEvent("account.updated", { id: account, object: "account" }, { account });
}

function deauthorized(account: string, created: number) {
  return stripeEvent(
    "account.application.deauthorized",
    { id: "ca_test", object: "application" },
    { account, created }
  );
}

describe("account.updated", () => {
  it("sets onboardingComplete from the account's current state in Stripe, not the payload", async () => {
    const tenant = await createTenant();
    await prisma.user.update({ where: { id: tenant.id }, data: { onboardingComplete: false } });
    const retrieve = vi
      .spyOn(stripe.accounts, "retrieve")
      .mockResolvedValue({ details_submitted: true, charges_enabled: true } as never);

    await processEvent(accountUpdated(tenant.stripeAccountId!));

    expect(retrieve).toHaveBeenCalledWith(tenant.stripeAccountId);
    expect((await reload(tenant.id)).onboardingComplete).toBe(true);
  });

  it("turns onboardingComplete off again when Stripe disables charges", async () => {
    const tenant = await createTenant();
    vi.spyOn(stripe.accounts, "retrieve").mockResolvedValue({
      details_submitted: true,
      charges_enabled: false,
    } as never);

    await processEvent(accountUpdated(tenant.stripeAccountId!));

    expect((await reload(tenant.id)).onboardingComplete).toBe(false);
  });

  it("doesn't call Stripe for an account that isn't linked to anyone", async () => {
    const retrieve = vi.spyOn(stripe.accounts, "retrieve");

    const processed = await processEvent(accountUpdated("acct_test_unlinked"));

    expect(processed.status).toBe("PROCESSED");
    expect(retrieve).not.toHaveBeenCalled();
  });
});

describe("account.application.deauthorized", () => {
  it("unlinks the account when the tenant disconnects", async () => {
    const tenant = await createTenant({ stripeConnectedAt: at(T) });

    await processEvent(deauthorized(tenant.stripeAccountId!, T + 60));

    expect(await reload(tenant.id)).toMatchObject({
      stripeAccountId: null,
      stripeConnectedAt: null,
      onboardingComplete: false,
    });
  });

  it("ignores a deauthorization that predates the current connection", async () => {
    // Disconnected at T, reconnected at T+60 — and only now does the queued
    // deauthorization get processed. It must not undo the reconnect.
    const tenant = await createTenant({ stripeConnectedAt: at(T + 60) });

    const processed = await processEvent(deauthorized(tenant.stripeAccountId!, T));

    expect(processed.status).toBe("PROCESSED");
    expect(await reload(tenant.id)).toMatchObject({
      stripeAccountId: tenant.stripeAccountId,
      onboardingComplete: true,
    });
  });
});
