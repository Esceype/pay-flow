-- Phase 4, step 2 of 2: Subscription becomes a real, tenant-scoped billing
-- record, and Transaction can point at the subscription it paid for.

-- The new NOT NULL columns (amount, currency, interval, requestKey, userId)
-- have no meaningful backfill value. No code path has ever written a
-- Subscription row before this migration, so instead of inventing data,
-- fail loudly if that assumption is somehow wrong.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Subscription") THEN
    RAISE EXCEPTION 'Subscription is expected to be empty before this migration';
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('DAY', 'WEEK', 'MONTH', 'YEAR');

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "amount" INTEGER NOT NULL,
ADD COLUMN "applicationFeeBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "canceledAt" TIMESTAMP(3),
ADD COLUMN "currency" TEXT NOT NULL,
ADD COLUMN "interval" "BillingInterval" NOT NULL,
ADD COLUMN "intervalCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "requestKey" TEXT NOT NULL,
ADD COLUMN "stripeCheckoutSessionId" TEXT,
ADD COLUMN "userId" TEXT NOT NULL,
-- Null until the customer completes Checkout and Stripe creates it.
ALTER COLUMN "stripeSubscriptionId" DROP NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'AWAITING_CHECKOUT';

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "subscriptionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_requestKey_key" ON "Subscription"("requestKey");
CREATE UNIQUE INDEX "Subscription_stripeCheckoutSessionId_key" ON "Subscription"("stripeCheckoutSessionId");
CREATE INDEX "Subscription_userId_status_idx" ON "Subscription"("userId", "status");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
