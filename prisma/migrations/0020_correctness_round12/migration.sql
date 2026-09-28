-- Round 12 (correctness): Shopify code usage limit with a lagging Shopify count (when the order was
-- recorded), Google Ads conversion adjustments (value Google has, retraction, retries), the items
-- kept for a claim's replacement order, and one running checkout test per element (partial unique
-- index). Additive: nullable columns or columns with defaults, one index, data backfills.

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "googleAdsAdjustAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "googleAdsAdjustError" TEXT,
ADD COLUMN     "googleAdsAdjustNextAt" TIMESTAMP(3),
ADD COLUMN     "googleAdsRetractedAt" TIMESTAMP(3),
ADD COLUMN     "googleAdsValueCents" INTEGER,
ADD COLUMN     "shopifyOrderAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ProtectionClaim" ADD COLUMN     "replacementLines" JSONB;

-- Data: conversions already uploaded carried the order total (what later adjustments compare with).
UPDATE "CheckoutSession" SET "googleAdsValueCents" = COALESCE(NULLIF("totalCents", 0), "subtotalCents")
WHERE "googleAdsUploadedAt" IS NOT NULL AND "googleAdsValueCents" IS NULL;

-- Data: Shopify orders recorded in the last day may not be in Shopify's code usage count yet.
UPDATE "CheckoutSession" SET "shopifyOrderAt" = "updatedAt"
WHERE "shopifyOrderId" IS NOT NULL AND "shopifyOrderAt" IS NULL AND "updatedAt" > now() - interval '1 day';

-- Data: at most one running test per element before the index (the oldest keeps running).
UPDATE "CheckoutTest" t SET "status" = 'STOPPED', "endedAt" = now(), "winner" = 'A'
WHERE t."status" = 'RUNNING' AND EXISTS (
  SELECT 1 FROM "CheckoutTest" o
  WHERE o."status" = 'RUNNING' AND o."storeId" = t."storeId" AND o."kind" = t."kind"
    AND COALESCE(o."targetId", '') = COALESCE(t."targetId", '')
    AND (o."startedAt" < t."startedAt" OR (o."startedAt" = t."startedAt" AND o."id" < t."id")));

-- CreateIndex: one running test per store, kind and target (partial, expression: not in schema.prisma).
CREATE UNIQUE INDEX "CheckoutTest_running_element_key" ON "CheckoutTest" ("storeId", "kind", COALESCE("targetId", '')) WHERE "status" = 'RUNNING';
