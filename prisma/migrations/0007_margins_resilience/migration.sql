-- AlterTable
ALTER TABLE "AddOn" ADD COLUMN     "costCents" INTEGER,
ADD COLUMN     "showIf" JSONB;

-- AlterTable
ALTER TABLE "CheckoutQuote" ADD COLUMN     "shippingCostCents" INTEGER;

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "addressEnteredAt" TIMESTAMP(3),
ADD COLUMN     "disputeEvidenceStartedAt" TIMESTAMP(3),
ADD COLUMN     "disputeLastTryAt" TIMESTAMP(3),
ADD COLUMN     "disputeOpenedAt" TIMESTAMP(3),
ADD COLUMN     "emailEnteredAt" TIMESTAMP(3),
ADD COLUMN     "nextRefundMirrorAt" TIMESTAMP(3),
ADD COLUMN     "pickupPoint" JSONB,
ADD COLUMN     "refundMirrorAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundMirrorStartedAt" TIMESTAMP(3),
ADD COLUMN     "shippingChosenAt" TIMESTAMP(3),
ADD COLUMN     "upsellShownBlocks" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ShippingRate" ADD COLUMN     "costCents" INTEGER,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'home';

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "autoFallback" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "fallbackActiveAt" TIMESTAMP(3),
ADD COLUMN     "fallbackReason" TEXT,
ADD COLUMN     "fulfillmentFeeCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ga4ApiSecret" TEXT,
ADD COLUMN     "ga4MeasurementId" TEXT,
ADD COLUMN     "metaAdAccountId" TEXT,
ADD COLUMN     "mondialRelayEnseigne" TEXT,
ADD COLUMN     "mondialRelayKey" TEXT,
ADD COLUMN     "quantityBreaks" JSONB,
ADD COLUMN     "tiktokAdvertiserId" TEXT,
ADD COLUMN     "vatExempt" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "UpsellCharge" ADD COLUMN     "disputeEvidenceStartedAt" TIMESTAMP(3),
ADD COLUMN     "disputeLastTryAt" TIMESTAMP(3),
ADD COLUMN     "disputeOpenedAt" TIMESTAMP(3),
ADD COLUMN     "nextRefundMirrorAt" TIMESTAMP(3),
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "refundMirrorAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundMirrorStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AdSpend" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignName" TEXT NOT NULL,
    "spendCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdSpend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertOutbox" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "sessionId" TEXT,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdSpend_storeId_day_idx" ON "AdSpend"("storeId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "AdSpend_storeId_day_platform_campaignId_key" ON "AdSpend"("storeId", "day", "platform", "campaignId");

-- CreateIndex
CREATE INDEX "AlertOutbox_sentAt_nextAttemptAt_idx" ON "AlertOutbox"("sentAt", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "CheckoutSession_whopCheckoutId_idx" ON "CheckoutSession"("whopCheckoutId");

-- CreateIndex
CREATE INDEX "CheckoutSession_storeId_paidAt_idx" ON "CheckoutSession"("storeId", "paidAt");

-- CreateIndex
CREATE INDEX "UpsellCharge_status_createdAt_idx" ON "UpsellCharge"("status", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_processedAt_receivedAt_idx" ON "WebhookEvent"("processedAt", "receivedAt");

-- AddForeignKey
ALTER TABLE "AdSpend" ADD CONSTRAINT "AdSpend_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Partial indexes for the background jobs and health checks (small, hot subsets).
CREATE INDEX "CheckoutSession_unsynced_idx" ON "CheckoutSession" ("paidAt") WHERE "status" = 'PAID' AND "shopifyOrderId" IS NULL;
CREATE INDEX "CheckoutSession_unmirrored_idx" ON "CheckoutSession" ("updatedAt") WHERE "refundedCents" > "refundMirroredCents";
CREATE INDEX "UpsellCharge_unmirrored_idx" ON "UpsellCharge" ("createdAt") WHERE "refundedCents" > "refundMirroredCents";

-- Disputes already open: timing starts from the migration (evidence logic keeps its margins).
UPDATE "CheckoutSession" SET "disputeOpenedAt" = now() WHERE "disputeId" IS NOT NULL AND "disputeOpenedAt" IS NULL;
UPDATE "UpsellCharge" SET "disputeOpenedAt" = now() WHERE "disputeId" IS NOT NULL AND "disputeOpenedAt" IS NULL;
