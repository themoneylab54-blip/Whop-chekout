-- Offer merge safety: opt-in merge of one-click offers into the checkout's Shopify order (with a
-- merge window), and the offer's payment recorded on that order tracked per offer.
-- Additive only (new columns with defaults / nullable), safe with the previous code running.

-- AlterTable
ALTER TABLE "Store" ADD COLUMN "mergeOffersIntoOrder" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "offerMergeWindowMin" INTEGER NOT NULL DEFAULT 10;

-- AlterTable
ALTER TABLE "UpsellCharge" ADD COLUMN "balanceSettledAt" TIMESTAMP(3),
ADD COLUMN "balanceAttempts" INTEGER NOT NULL DEFAULT 0;

-- Offers merged before this migration: their balance was paid at merge time unless an
-- "upsell.merge_unpaid" alert was raised for their checkout (those stay open for the tick).
UPDATE "UpsellCharge" c SET "balanceSettledAt" = c."createdAt"
WHERE c."orderMode" = 'merged'
  AND NOT EXISTS (SELECT 1 FROM "EventLog" e WHERE e."sessionId" = c."sessionId" AND e.kind = 'upsell.merge_unpaid');
