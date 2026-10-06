-- Shopify reconnection: the shop and app credentials typed in the form are kept apart ("pending") until
-- Shopify's OAuth callback proves them (valid signature with that secret + successful token exchange).
-- Only then do they replace the active credentials; any failure clears them and leaves the working
-- connection untouched. Additive.

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "shopifyPendingAt" TIMESTAMP(3),
ADD COLUMN     "shopifyPendingClientId" TEXT,
ADD COLUMN     "shopifyPendingClientSecret" TEXT,
ADD COLUMN     "shopifyPendingShopDomain" TEXT;
