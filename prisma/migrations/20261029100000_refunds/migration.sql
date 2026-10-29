-- Phase 7: refunds (ADR-011).

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- AlterTable
ALTER TABLE "MaterializedRevenueStats" ADD COLUMN "totalRefunds" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "refundId" TEXT,
ADD COLUMN "stripeInvoiceId" TEXT,
ADD COLUMN "stripePaymentIntentId" TEXT;

-- Subscription payments recorded before this migration: their Stripe
-- invoice id is in the invoice.paid event that recorded them, which is
-- still stored. (Payment intent ids are looked up on demand, so they need
-- no backfill.)
UPDATE "Transaction" t
SET "stripeInvoiceId" = w."payload"->'data'->'object'->>'id'
FROM "WebhookEvent" w
WHERE w."stripeEventId" = t."stripeEventId"
  AND w."type" = 'invoice.paid'
  AND t."subscriptionId" IS NOT NULL
  AND t."stripeInvoiceId" IS NULL;

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "stripeRefundId" TEXT,
    "requestKey" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Refund_stripeRefundId_key" ON "Refund"("stripeRefundId");
CREATE UNIQUE INDEX "Refund_requestKey_key" ON "Refund"("requestKey");
CREATE INDEX "Refund_paymentId_idx" ON "Refund"("paymentId");
CREATE INDEX "Refund_userId_createdAt_idx" ON "Refund"("userId", "createdAt");
CREATE INDEX "Transaction_stripePaymentIntentId_idx" ON "Transaction"("stripePaymentIntentId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
