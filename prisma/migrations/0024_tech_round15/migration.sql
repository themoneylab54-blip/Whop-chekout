-- Round 15 (reliability / observability): per-provider call metrics rolled up in 5-minute buckets
-- (error rate, latency histogram, last success / error) and the discount codes of the Shopify orders
-- placed outside this checkout (calibration of Shopify's code usage count). Additive: a new table and
-- a column with a default.

-- AlterTable
ALTER TABLE "ExternalOrder" ADD COLUMN     "discountCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ProviderMetric" (
    "provider" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "timeouts" INTEGER NOT NULL DEFAULT 0,
    "totalMs" BIGINT NOT NULL DEFAULT 0,
    "maxMs" INTEGER NOT NULL DEFAULT 0,
    "h0" INTEGER NOT NULL DEFAULT 0,
    "h1" INTEGER NOT NULL DEFAULT 0,
    "h2" INTEGER NOT NULL DEFAULT 0,
    "h3" INTEGER NOT NULL DEFAULT 0,
    "h4" INTEGER NOT NULL DEFAULT 0,
    "h5" INTEGER NOT NULL DEFAULT 0,
    "h6" INTEGER NOT NULL DEFAULT 0,
    "h7" INTEGER NOT NULL DEFAULT 0,
    "lastOkAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "ProviderMetric_pkey" PRIMARY KEY ("provider","bucket")
);

-- CreateIndex
CREATE INDEX "ProviderMetric_bucket_idx" ON "ProviderMetric"("bucket");
