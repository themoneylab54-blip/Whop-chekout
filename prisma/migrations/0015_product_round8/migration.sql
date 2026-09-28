-- Round 8 (product): app costs on offers, merged offer orders, translations of bumps and
-- shipping rates, geo-IP country, shipping-protection claims, ad-spend VAT for exempt stores.

-- AlterTable
ALTER TABLE "Store" ADD COLUMN "adSpendVatNonReclaimable" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ShippingRate" ADD COLUMN "i18n" JSONB;

-- AlterTable
ALTER TABLE "AddOn" ADD COLUMN "i18n" JSONB;

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN "geoCountry" TEXT;

-- AlterTable
ALTER TABLE "UpsellCharge" ADD COLUMN "costSource" TEXT,
ADD COLUMN "shopifyCostCents" INTEGER,
ADD COLUMN "orderMode" TEXT,
ADD COLUMN "shopifyLineItemId" TEXT;

-- CreateTable
CREATE TABLE "ProtectionClaim" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "costCents" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProtectionClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProtectionClaim_storeId_createdAt_idx" ON "ProtectionClaim"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "ProtectionClaim_sessionId_idx" ON "ProtectionClaim"("sessionId");

-- AddForeignKey
ALTER TABLE "ProtectionClaim" ADD CONSTRAINT "ProtectionClaim_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CheckoutSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
