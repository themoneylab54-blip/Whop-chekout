-- Round 14 (correctness): backoff of the background ad-conversion retries (their own clock instead of
-- updatedAt), the store's home country (VAT), the calibration of Shopify's code usage count (whether
-- it counts the orders this app creates, and Shopify's count read before each use), and checkout
-- periods switched off by hand next to the automatic fallback ones. Additive: nullable columns and
-- columns with a default.

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "pixelNextAttemptAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "UpsellCharge" ADD COLUMN     "pixelNextAttemptAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "homeCountry" TEXT NOT NULL DEFAULT 'FR',
ADD COLUMN     "shopifyCountsApiOrders" BOOLEAN;

-- AlterTable
ALTER TABLE "ShopifyCodeUse" ADD COLUMN     "shopifyCountBefore" INTEGER;

-- AlterTable
ALTER TABLE "FallbackPeriod" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'fallback';
