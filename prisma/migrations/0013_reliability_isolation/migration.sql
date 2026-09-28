-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "alertRefundAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "alertRefundNextAt" TIMESTAMP(3),
ADD COLUMN     "disputeTaggedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "UpsellCharge" ADD COLUMN     "disputeTaggedAt" TIMESTAMP(3),
ADD COLUMN     "syncAmbiguousAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "deliveries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "firstReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;


-- Backfill: a failing event's retry window runs from its first receipt.
UPDATE "WebhookEvent" SET "firstReceivedAt" = "receivedAt" WHERE "receivedAt" < "firstReceivedAt";

-- Backfill: disputed orders that already exist in Shopify were tagged when the dispute
-- opened (the new tick backstop only covers disputes from now on).
UPDATE "CheckoutSession" SET "disputeTaggedAt" = now() WHERE "disputed" AND "shopifyOrderId" IS NOT NULL;
UPDATE "UpsellCharge" SET "disputeTaggedAt" = now() WHERE "disputed" AND "shopifyOrderId" IS NOT NULL;
