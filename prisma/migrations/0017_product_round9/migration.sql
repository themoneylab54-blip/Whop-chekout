-- Round 9 (product): Google Ads spend import credentials, local-currency charging, returning-buyer
-- e-mail codes, Shopify discount codes / automatic cart discounts on quotes, buyer-reported
-- protection claims (pending → approved / rejected). Additive only: new nullable columns or
-- columns with defaults, one new table; existing claims stay "approved" (typed by the merchant).

-- AlterTable
ALTER TABLE "CheckoutQuote" ADD COLUMN     "automaticDiscountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "chargeCurrency" TEXT,
ADD COLUMN     "chargeFxRate" DOUBLE PRECISION,
ADD COLUMN     "chargeTotalCents" INTEGER,
ADD COLUMN     "codeDiscountCents" INTEGER,
ADD COLUMN     "discountSource" TEXT;

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "cartDiscounts" JSONB,
ADD COLUMN     "cartToken" TEXT,
ADD COLUMN     "chargeCurrency" TEXT,
ADD COLUMN     "chargeFxRate" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "ProtectionClaim" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "photoUrl" TEXT,
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'merchant',
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'approved';

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "chargeLocalCurrency" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "googleAdsClientId" TEXT,
ADD COLUMN     "googleAdsClientSecret" TEXT,
ADD COLUMN     "googleAdsCustomerId" TEXT,
ADD COLUMN     "googleAdsDeveloperToken" TEXT,
ADD COLUMN     "googleAdsLoginCustomerId" TEXT,
ADD COLUMN     "googleAdsRefreshToken" TEXT,
ADD COLUMN     "returningBuyerCode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shopifyDiscountCodes" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "BuyerLoginCode" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerLoginCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuyerLoginCode_storeId_email_createdAt_idx" ON "BuyerLoginCode"("storeId", "email", "createdAt");

-- CreateIndex
CREATE INDEX "BuyerLoginCode_sessionId_idx" ON "BuyerLoginCode"("sessionId");

-- CreateIndex
CREATE INDEX "ProtectionClaim_storeId_status_idx" ON "ProtectionClaim"("storeId", "status");

