-- Cart line fidelity (bundle / gift / upsell / personalization apps). Additive only.
-- 1. The Shopify cart's note and attributes (re-read from /cart.js), copied to the order.
--    Line properties, app prices and bundle components live in the existing lines JSON.
-- 2. A redacted /cart.js copy for carts holding app lines (support diagnostics, purged after 7 days).

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "cartContext" JSONB;

-- CreateTable
CREATE TABLE "CartSnapshot" (
    "sessionId" TEXT NOT NULL,
    "apps" TEXT[],
    "unknownKeys" TEXT[],
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CartSnapshot_pkey" PRIMARY KEY ("sessionId")
);

-- CreateIndex
CREATE INDEX "CartSnapshot_createdAt_idx" ON "CartSnapshot"("createdAt");

-- AddForeignKey
ALTER TABLE "CartSnapshot" ADD CONSTRAINT "CartSnapshot_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CheckoutSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
