-- Round 10 (product): discount stacking rules (app codes × quantity breaks), store time zone,
-- cross-store returning buyers, platform-reported conversions per ad spend row, Google Ads offline
-- conversion uploads, claim photos (bytea, 5 MB / image, 3 per claim), reship replacement orders
-- and buyer decision e-mails, A/B tests of checkout elements (quantity breaks, order bump,
-- shipping protection). Additive only: new nullable columns or columns with defaults, two new tables.

-- AlterTable
ALTER TABLE "AdSpend" ADD COLUMN     "platformConversionValueCents" INTEGER,
ADD COLUMN     "platformConversions" DOUBLE PRECISION,
ADD COLUMN     "platformRoas" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "checkoutTestArms" JSONB,
ADD COLUMN     "googleAdsUploadAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "googleAdsUploadError" TEXT,
ADD COLUMN     "googleAdsUploadedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DiscountCode" ADD COLUMN     "combinesWithBreaks" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ProtectionClaim" ADD COLUMN     "buyerNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "replacementError" TEXT,
ADD COLUMN     "replacementOrderId" TEXT,
ADD COLUMN     "replacementOrderName" TEXT,
ADD COLUMN     "replacementStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "breaksCombineWithCodes" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "googleAdsConversionAction" TEXT,
ADD COLUMN     "storeNetwork" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Europe/Paris';

-- CreateTable
CREATE TABLE "ClaimPhoto" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckoutTest" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT,
    "name" TEXT NOT NULL,
    "splitB" INTEGER NOT NULL DEFAULT 50,
    "configB" JSONB NOT NULL,
    "configA" JSONB,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "winner" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "CheckoutTest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClaimPhoto_claimId_idx" ON "ClaimPhoto"("claimId");

-- CreateIndex
CREATE INDEX "CheckoutTest_storeId_status_idx" ON "CheckoutTest"("storeId", "status");

-- AddForeignKey
ALTER TABLE "ClaimPhoto" ADD CONSTRAINT "ClaimPhoto_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ProtectionClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutTest" ADD CONSTRAINT "CheckoutTest_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

