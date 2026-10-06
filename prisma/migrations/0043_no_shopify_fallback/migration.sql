-- The storefront never switches to Shopify's checkout on its own any more: the automatic
-- fallback is off for every store, and a store currently switched gets our checkout back.
ALTER TABLE "Store" ALTER COLUMN "autoFallback" SET DEFAULT false;
UPDATE "Store" SET "autoFallback" = false;
UPDATE "FallbackPeriod" SET "endedAt" = NOW() WHERE "endedAt" IS NULL AND "kind" = 'fallback';
UPDATE "Store" SET "fallbackActiveAt" = NULL, "fallbackReason" = NULL WHERE "fallbackActiveAt" IS NOT NULL;
