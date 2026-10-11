-- Phase 5: MaterializedRevenueStats becomes one row per tenant per currency.

-- This table is derived data — every row can be recomputed from
-- Subscription and Transaction, and the worker does exactly that on boot,
-- nightly, and after every revenue-affecting event. So the new NOT NULL
-- columns aren't backfilled: the table is emptied and rebuilt.
TRUNCATE TABLE "MaterializedRevenueStats";

-- AlterTable
ALTER TABLE "MaterializedRevenueStats" DROP CONSTRAINT "MaterializedRevenueStats_pkey",
DROP COLUMN "updatedAt",
ADD COLUMN "activeSubscriptions" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "computedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN "currency" TEXT NOT NULL,
ALTER COLUMN "totalRevenue" SET DATA TYPE BIGINT,
ADD CONSTRAINT "MaterializedRevenueStats_pkey" PRIMARY KEY ("userId", "currency");
