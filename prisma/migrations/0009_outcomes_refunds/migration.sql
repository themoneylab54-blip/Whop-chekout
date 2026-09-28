-- AlterTable
ALTER TABLE "AdSpend" ADD COLUMN     "fxRate" DOUBLE PRECISION,
ADD COLUMN     "originalCurrency" TEXT,
ADD COLUMN     "originalSpendCents" INTEGER;

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "addOnsShown" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "disputeLostCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "disputeStatus" TEXT;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "disputeFeeCents" INTEGER NOT NULL DEFAULT 1500,
ADD COLUMN     "fixedCostsMonthlyCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "UpsellCharge" ADD COLUMN     "disputeLostCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "disputeStatus" TEXT,
ADD COLUMN     "nextCheckAt" TIMESTAMP(3),
ADD COLUMN     "previousPaymentIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "RefundRecord" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "chargeId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RefundRecord_storeId_createdAt_idx" ON "RefundRecord"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "RefundRecord_sessionId_idx" ON "RefundRecord"("sessionId");

-- CreateIndex
CREATE INDEX "EventLog_kind_createdAt_idx" ON "EventLog"("kind", "createdAt");


-- Refund/dispute lookups by duplicate payment id (every webhook and reconcile batch).
CREATE INDEX "CheckoutSession_extraPaymentIds_idx" ON "CheckoutSession" USING GIN ("extraPaymentIds");
CREATE INDEX "UpsellCharge_previousPaymentIds_idx" ON "UpsellCharge" USING GIN ("previousPaymentIds");
