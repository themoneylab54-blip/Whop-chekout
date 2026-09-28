-- Checkout domains: since when a domain has been waiting for its verification (saved, or lost), so
-- the tick's re-checks of an abandoned one back off (hourly after 48 h, daily after 7 days).
-- Additive: a nullable column; the domains pending today start their 48 h now.

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "checkoutDomainPendingSince" TIMESTAMP(3);

UPDATE "Store" SET "checkoutDomainPendingSince" = CURRENT_TIMESTAMP
WHERE "checkoutDomain" IS NOT NULL AND "checkoutDomainVerifiedAt" IS NULL;
