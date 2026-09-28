-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "alertRefundKey" TEXT,
ADD COLUMN     "alertRefundPendingAt" TIMESTAMP(3),
ADD COLUMN     "firstUtm" JSONB,
ADD COLUMN     "lang" TEXT,
ADD COLUMN     "surveyAnswer" TEXT,
ADD COLUMN     "syncAmbiguousAt" TIMESTAMP(3),
ADD COLUMN     "syncHandledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "attributionDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "supplierPaidAtPayment" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "UpsellCharge" ADD COLUMN     "syncHandledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ProductCost" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "title" TEXT,
    "costCents" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductCost_storeId_variantId_idx" ON "ProductCost"("storeId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCost_storeId_variantId_effectiveFrom_key" ON "ProductCost"("storeId", "variantId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "CheckoutSession_refundedCents_idx" ON "CheckoutSession"("refundedCents");

-- CreateIndex
CREATE INDEX "CheckoutSession_disputeId_idx" ON "CheckoutSession"("disputeId");

-- CreateIndex
CREATE INDEX "UpsellCharge_disputeId_idx" ON "UpsellCharge"("disputeId");

-- AddForeignKey
ALTER TABLE "ProductCost" ADD CONSTRAINT "ProductCost_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

