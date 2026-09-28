-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "clientIp" TEXT,
ADD COLUMN     "disputeEvidenceAt" TIMESTAMP(3),
ADD COLUMN     "experimentId" TEXT,
ADD COLUMN     "extraPaymentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "nextSyncAt" TIMESTAMP(3),
ADD COLUMN     "payClickedAt" TIMESTAMP(3),
ADD COLUMN     "paymentFailedAt" TIMESTAMP(3),
ADD COLUMN     "paymentMethodType" TEXT,
ADD COLUMN     "pixelAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pixelSentAt" TIMESTAMP(3),
ADD COLUMN     "pixelStatus" JSONB,
ADD COLUMN     "preparedAt" TIMESTAMP(3),
ADD COLUMN     "refundMirroredCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "syncAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "test" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tracking" JSONB,
ADD COLUMN     "trackingCheckedAt" TIMESTAMP(3),
ADD COLUMN     "trackingNumber" TEXT,
ADD COLUMN     "trackingPushedAt" TIMESTAMP(3),
ADD COLUMN     "upsellShownAt" TIMESTAMP(3),
ADD COLUMN     "userAgent" TEXT,
ADD COLUMN     "variant" TEXT,
ADD COLUMN     "visitorId" TEXT,
ADD COLUMN     "whopMemberId" TEXT,
ADD COLUMN     "whopPaymentMethodId" TEXT;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "alertEmail" TEXT,
ADD COLUMN     "autoDisputeEvidence" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "autoRefundFraudAlerts" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "draftCheckoutLayout" JSONB,
ADD COLUMN     "draftThankYouLayout" JSONB,
ADD COLUMN     "draftTheme" JSONB,
ADD COLUMN     "draftUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "emailFrom" TEXT,
ADD COLUMN     "lastWebhookAt" TIMESTAMP(3),
ADD COLUMN     "metaAccessToken" TEXT,
ADD COLUMN     "metaContentIdFormat" TEXT NOT NULL DEFAULT 'variant',
ADD COLUMN     "metaPixelId" TEXT,
ADD COLUMN     "metaTestEventCode" TEXT,
ADD COLUMN     "paymentMethods" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "pixelRequireConsent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "pushTracking" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "resendApiKey" TEXT,
ADD COLUMN     "statementDescriptor" TEXT,
ADD COLUMN     "telegramBotToken" TEXT,
ADD COLUMN     "telegramChatId" TEXT,
ADD COLUMN     "tiktokAccessToken" TEXT,
ADD COLUMN     "tiktokPixelId" TEXT;

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "payload" JSONB,
ADD COLUMN     "processedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EventLog" (
    "id" TEXT NOT NULL,
    "storeId" TEXT,
    "sessionId" TEXT,
    "level" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LayoutVersion" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "theme" JSONB NOT NULL,
    "checkoutLayout" JSONB NOT NULL,
    "thankYouLayout" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LayoutVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "versionIdA" TEXT,
    "versionId" TEXT NOT NULL,
    "splitB" INTEGER NOT NULL DEFAULT 50,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpsellCharge" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "whopPaymentId" TEXT,
    "shopifyOrderId" TEXT,
    "shopifyOrderName" TEXT,
    "error" TEXT,
    "syncAttempts" INTEGER NOT NULL DEFAULT 0,
    "syncStartedAt" TIMESTAMP(3),
    "nextSyncAt" TIMESTAMP(3),
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpsellCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "EventLog_storeId_createdAt_idx" ON "EventLog"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "EventLog_sessionId_idx" ON "EventLog"("sessionId");

-- CreateIndex
CREATE INDEX "LayoutVersion_storeId_createdAt_idx" ON "LayoutVersion"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "Experiment_storeId_status_idx" ON "Experiment"("storeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UpsellCharge_whopPaymentId_key" ON "UpsellCharge"("whopPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "UpsellCharge_sessionId_blockId_key" ON "UpsellCharge"("sessionId", "blockId");

-- CreateIndex
CREATE INDEX "CheckoutSession_status_createdAt_idx" ON "CheckoutSession"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "EventLog" ADD CONSTRAINT "EventLog_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayoutVersion" ADD CONSTRAINT "LayoutVersion_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellCharge" ADD CONSTRAINT "UpsellCharge_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CheckoutSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: refunds recorded before this migration were already reported on their Shopify orders.
UPDATE "CheckoutSession" SET "refundMirroredCents" = "refundedCents" WHERE "shopifyOrderId" IS NOT NULL;

-- Backfill: webhook events stored before this migration were fully handled.
UPDATE "WebhookEvent" SET "processedAt" = "receivedAt" WHERE "processedAt" IS NULL;
