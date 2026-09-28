-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "disputeTagAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "disputeTagGaveUpAt" TIMESTAMP(3),
ADD COLUMN     "lastRefundAt" TIMESTAMP(3),
ADD COLUMN     "nextDisputeTagAt" TIMESTAMP(3),
ADD COLUMN     "syncSkippedReason" TEXT,
ADD COLUMN     "trackingGaveUpAt" TIMESTAMP(3),
ADD COLUMN     "trackingPushAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "trackingPushError" TEXT;

-- AlterTable
ALTER TABLE "WebhookEvent" DROP CONSTRAINT "WebhookEvent_pkey",
ADD CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("storeId", "id");

-- AlterTable
ALTER TABLE "UpsellCharge" ADD COLUMN     "disputeTagAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "disputeTagGaveUpAt" TIMESTAMP(3),
ADD COLUMN     "lastRefundAt" TIMESTAMP(3),
ADD COLUMN     "nextDisputeTagAt" TIMESTAMP(3),
ADD COLUMN     "syncSkippedReason" TEXT;

-- CreateIndex
CREATE INDEX "WebhookEvent_id_idx" ON "WebhookEvent"("id");


-- Existing rows keep their storeId: the per-store key (storeId, id) is unique for them
-- already (the old key was the id alone).

-- Legacy "not ours" refund markers written under the shared applied-refund key by older
-- versions: moved to their per-store key, so they can never read as "applied".
INSERT INTO "WebhookEvent" ("id", "storeId", "type", "receivedAt", "processedAt", "firstReceivedAt")
SELECT 'refund-skip:' || w."storeId" || ':' || substring(w."id" from 8), w."storeId", 'refund.skipped', w."receivedAt", w."processedAt", w."firstReceivedAt"
FROM "WebhookEvent" w
WHERE w."id" LIKE 'refund:%' AND w."type" = 'refund.skipped'
ON CONFLICT DO NOTHING;
DELETE FROM "WebhookEvent" WHERE "id" LIKE 'refund:%' AND "type" = 'refund.skipped';

-- Backfill: the last refund's own date ages the "refund not yet mirrored" backlog.
UPDATE "CheckoutSession" s SET "lastRefundAt" = r.at
FROM (SELECT "sessionId", max("createdAt") AS at FROM "RefundRecord" WHERE "chargeId" IS NULL GROUP BY "sessionId") r
WHERE s.id = r."sessionId";
UPDATE "UpsellCharge" c SET "lastRefundAt" = r.at
FROM (SELECT "chargeId", max("createdAt") AS at FROM "RefundRecord" WHERE "chargeId" IS NOT NULL GROUP BY "chargeId") r
WHERE c.id = r."chargeId";
