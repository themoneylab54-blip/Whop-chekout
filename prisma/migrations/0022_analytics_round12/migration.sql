-- Round 12 (analytics): the conversion value mode each ad spend row was reported with (platform
-- ROAS vs POAS), the history of the Shopify-checkout fallback periods, Shopify orders placed outside
-- this checkout (leakage), the buyers' Shopify order history (new vs returning) and per-variant VAT
-- categories (reduced rates). Additive: nullable columns, new tables, data backfills.

-- AlterTable
ALTER TABLE "AdSpend" ADD COLUMN     "valueMode" TEXT;

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "shopifyPriorOrders" INTEGER;

-- CreateTable
CREATE TABLE "FallbackPeriod" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "reason" TEXT,

    CONSTRAINT "FallbackPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalOrder" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "orderedAt" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "htCents" INTEGER NOT NULL,
    "countryCode" TEXT,
    "sourceName" TEXT,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyCustomer" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "shopifyCustomerId" TEXT,
    "firstOrderAt" TIMESTAMP(3),
    "numberOfOrders" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVat" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "title" TEXT,
    "category" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FallbackPeriod_storeId_startedAt_idx" ON "FallbackPeriod"("storeId", "startedAt");

-- CreateIndex
CREATE INDEX "ExternalOrder_storeId_orderedAt_idx" ON "ExternalOrder"("storeId", "orderedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalOrder_storeId_shopifyOrderId_key" ON "ExternalOrder"("storeId", "shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyCustomer_storeId_email_key" ON "ShopifyCustomer"("storeId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVat_storeId_variantId_key" ON "ProductVat"("storeId", "variantId");

-- AddForeignKey
ALTER TABLE "FallbackPeriod" ADD CONSTRAINT "FallbackPeriod_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalOrder" ADD CONSTRAINT "ExternalOrder_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyCustomer" ADD CONSTRAINT "ShopifyCustomer_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVat" ADD CONSTRAINT "ProductVat_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Data: value mode of the rows already imported. Google Ads always receives the order amount
-- (revenue); Meta / TikTok received the store's value mode, whose history was not recorded before
-- this migration: its current setting is the best estimate. Manual / CSV rows carry no platform value.
UPDATE "AdSpend" SET "valueMode" = 'revenue' WHERE "platform" = 'google';
UPDATE "AdSpend" a SET "valueMode" = CASE WHEN s."conversionValueMode" = 'profit' THEN 'profit' ELSE 'revenue' END
FROM "Store" s
WHERE s.id = a."storeId" AND a."platform" IN ('meta', 'tiktok')
  AND (a."platformConversions" IS NOT NULL OR a."platformConversionValueCents" IS NOT NULL);

-- Data: fallback periods still in the journal (activation → next reactivation, automatic or
-- manual), then the one active now when the journal no longer has it.
INSERT INTO "FallbackPeriod" ("id", "storeId", "startedAt", "endedAt", "reason")
SELECT 'fbp_' || e.id, e."storeId", e."createdAt",
       (SELECT min(c."createdAt") FROM "EventLog" c
        WHERE c."storeId" = e."storeId" AND c.kind IN ('fallback.cleared', 'fallback.cleared_manually') AND c."createdAt" > e."createdAt"),
       left(e.message, 300)
FROM "EventLog" e
WHERE e.kind = 'fallback.activated' AND e."storeId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "Store" st WHERE st.id = e."storeId");
-- An activation without a reactivation in the journal is only kept when it is the store's current fallback.
DELETE FROM "FallbackPeriod" p USING "Store" s
WHERE p."storeId" = s.id AND p."endedAt" IS NULL
  AND NOT (s."fallbackActiveAt" IS NOT NULL AND s."fallbackActiveAt" BETWEEN p."startedAt" - interval '1 minute' AND p."startedAt" + interval '1 minute');
INSERT INTO "FallbackPeriod" ("id", "storeId", "startedAt", "endedAt", "reason")
SELECT 'fbp_now_' || s.id, s.id, s."fallbackActiveAt", NULL, s."fallbackReason"
FROM "Store" s
WHERE s."fallbackActiveAt" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "FallbackPeriod" p WHERE p."storeId" = s.id AND p."endedAt" IS NULL);
