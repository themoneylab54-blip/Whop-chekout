-- Round 11 (reliability): Shopify code usage ledger (usage limit / once per customer checked in
-- markPaid's transaction), the Shopify code limits frozen on the quote snapshot, refunds counted in
-- the charge currency, and Shopify codes off by default where the read_discounts scope is missing.
-- Additive: new columns with defaults or nullable, one new table, data backfills.

-- AlterTable
ALTER TABLE "CheckoutQuote" ADD COLUMN     "shopifyCodeCheckedAt" TIMESTAMP(3),
ADD COLUMN     "shopifyCodeOncePerCustomer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shopifyCodeUsageCount" INTEGER,
ADD COLUMN     "shopifyCodeUsageLimit" INTEGER;

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "refundedChargeCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Store" ALTER COLUMN "shopifyDiscountCodes" SET DEFAULT false;

-- CreateTable
CREATE TABLE "ShopifyCodeUse" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyCodeUse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyCodeUse_sessionId_key" ON "ShopifyCodeUse"("sessionId");

-- CreateIndex
CREATE INDEX "ShopifyCodeUse_storeId_code_createdAt_idx" ON "ShopifyCodeUse"("storeId", "code", "createdAt");

-- CreateIndex
CREATE INDEX "ShopifyCodeUse_storeId_code_email_idx" ON "ShopifyCodeUse"("storeId", "code", "email");

-- AddForeignKey
ALTER TABLE "ShopifyCodeUse" ADD CONSTRAINT "ShopifyCodeUse_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data: Shopify codes can't be looked up without read_discounts (every lookup failed and was
-- logged as "not found"): off for those stores. The merchant re-enables it after reconnecting.
UPDATE "Store" SET "shopifyDiscountCodes" = false
WHERE "shopifyDiscountCodes" = true
  AND ("shopifyScopes" IS NULL
       OR NOT (string_to_array(replace("shopifyScopes", ' ', ''), ',') && ARRAY['read_discounts', 'write_discounts']::text[]));

-- Data: past paid uses of Shopify codes seed the ledger (once per customer covers them too).
INSERT INTO "ShopifyCodeUse" ("id", "storeId", "code", "sessionId", "email", "createdAt")
SELECT 'bf_' || s."id", s."storeId", upper(q."discountCode"), s."id", lower(s."email"), COALESCE(s."paidAt", s."createdAt")
FROM "CheckoutSession" s JOIN "CheckoutQuote" q ON q."id" = s."paidQuoteId"
WHERE s."status" = 'PAID' AND q."discountSource" = 'shopify' AND q."discountCode" IS NOT NULL
ON CONFLICT DO NOTHING;

-- Data: refunds already recorded on orders charged in the buyer's currency, in that currency
-- (a fully refunded order counts its whole charge; a partial one at the paid quote's rate).
UPDATE "CheckoutSession" s
SET "refundedChargeCents" = CASE WHEN s."refundedCents" >= s."totalCents" THEN q."chargeTotalCents" ELSE round(s."refundedCents" * s."chargeFxRate")::int END
FROM "CheckoutQuote" q
WHERE q."id" = s."paidQuoteId" AND s."chargeCurrency" IS NOT NULL AND s."chargeFxRate" IS NOT NULL
  AND s."refundedCents" > 0 AND q."chargeTotalCents" IS NOT NULL;
