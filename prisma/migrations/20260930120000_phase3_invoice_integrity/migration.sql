-- Phase 3 hardening: invoice integrity, tenant denormalization, Connect
-- deauthorization ordering guard. Written by hand (not a raw diff) so the
-- new NOT NULL columns are backfilled for any existing rows instead of
-- failing the migration.

-- AlterEnum
ALTER TYPE "InvoiceStatus" ADD VALUE 'EXPIRED';

-- Customer deletion must not cascade into billing history: Restrict.
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_customerId_fkey";
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_customerId_fkey";

-- (userId, email) becomes unique; the old non-unique index is redundant.
DROP INDEX "Customer_userId_email_idx";

-- Redundant: the @unique on stripeAccountId already provides this index.
DROP INDEX "User_stripeAccountId_idx";

-- New Invoice columns: add nullable, backfill, then enforce NOT NULL.
ALTER TABLE "Invoice" ADD COLUMN "applicationFeeAmount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "requestKey" TEXT,
ADD COLUMN "userId" TEXT;

UPDATE "Invoice" i SET "userId" = c."userId" FROM "Customer" c WHERE c."id" = i."customerId";
-- Pre-existing invoices had no request key; their own id is unique by definition.
UPDATE "Invoice" SET "requestKey" = "id" WHERE "requestKey" IS NULL;

ALTER TABLE "Invoice" ALTER COLUMN "requestKey" SET NOT NULL,
ALTER COLUMN "userId" SET NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "stripeConnectedAt" TIMESTAMP(3);
-- Best available approximation for accounts linked before this column existed.
UPDATE "User" SET "stripeConnectedAt" = "updatedAt" WHERE "stripeAccountId" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Customer_userId_email_key" ON "Customer"("userId", "email");
CREATE UNIQUE INDEX "Invoice_requestKey_key" ON "Invoice"("requestKey");
CREATE INDEX "Invoice_userId_createdAt_idx" ON "Invoice"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
