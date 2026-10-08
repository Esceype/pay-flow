-- Phase 4, step 1 of 2: new SubscriptionStatus values only.
--
-- Kept in its own migration on purpose: PostgreSQL refuses to *use* an enum
-- value in the same transaction that added it ("unsafe use of new value"),
-- and the next migration sets one of these as a column default.

-- AlterEnum
ALTER TYPE "SubscriptionStatus" ADD VALUE 'AWAITING_CHECKOUT';
ALTER TYPE "SubscriptionStatus" ADD VALUE 'INCOMPLETE_EXPIRED';
ALTER TYPE "SubscriptionStatus" ADD VALUE 'TRIALING';
ALTER TYPE "SubscriptionStatus" ADD VALUE 'PAUSED';
