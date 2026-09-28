-- Round 13 (correctness): Google Ads adjustment candidates flagged by the writers that change a
-- conversion's value (refund, dispute outcome, offer paid), the wait after an ambiguous replacement
-- order attempt, and one pending buyer claim per order (partial unique index). Additive: a column
-- with a default, a nullable column, two indexes, data backfills.

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "googleAdsAdjustDue" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ProtectionClaim" ADD COLUMN     "replacementAmbiguousAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "CheckoutSession_storeId_googleAdsAdjustDue_idx" ON "CheckoutSession"("storeId", "googleAdsAdjustDue");

-- Data: uploaded, not retracted conversions whose value now differs from what Google has (the rule of
-- googleAdjustmentFor: retraction when fully refunded or dispute lost; else paid − refunded plus the
-- paid offers net of their refunds and lost disputes) are due for an adjustment, tries given back.
UPDATE "CheckoutSession" s SET "googleAdsAdjustDue" = true, "googleAdsAdjustAttempts" = 0, "googleAdsAdjustNextAt" = NULL
FROM (
  SELECT s2.id,
    COALESCE(NULLIF(s2."totalCents", 0), s2."subtotalCents") AS paid,
    COALESCE((SELECT sum(GREATEST(0, u."amountCents" - u."refundedCents" - u."disputeLostCents")) FROM "UpsellCharge" u WHERE u."sessionId" = s2.id AND u.status = 'PAID'), 0) AS offers
  FROM "CheckoutSession" s2
  WHERE s2."googleAdsUploadedAt" IS NOT NULL AND s2."googleAdsRetractedAt" IS NULL AND s2."test" = false
) v
WHERE s.id = v.id AND (
  s."disputeStatus" = 'lost'
  OR (v.paid > 0 AND s."refundedCents" >= v.paid)
  OR GREATEST(0, v.paid - s."refundedCents") + v.offers <> COALESCE(s."googleAdsValueCents", v.paid)
);

-- Data: a replacement order whose last attempt had no sure answer from Shopify waits from that attempt.
UPDATE "ProtectionClaim" SET "replacementAmbiguousAt" = COALESCE("replacementStartedAt", now())
WHERE "replacementOrderId" IS NULL AND "replacementError" LIKE '%incertaine%';

-- Data: at most one pending buyer claim per order before the index (the oldest stays pending).
UPDATE "ProtectionClaim" c SET "status" = 'rejected', "decidedAt" = now(), "note" = COALESCE(c."note" || ' ', '') || '(doublon d''un signalement en attente)'
WHERE c."status" = 'pending' AND EXISTS (
  SELECT 1 FROM "ProtectionClaim" o
  WHERE o."status" = 'pending' AND o."sessionId" = c."sessionId"
    AND (o."createdAt" < c."createdAt" OR (o."createdAt" = c."createdAt" AND o."id" < c."id")));

-- CreateIndex: one pending claim per order (partial: not in schema.prisma).
CREATE UNIQUE INDEX "ProtectionClaim_pending_session_key" ON "ProtectionClaim" ("sessionId") WHERE "status" = 'pending';
