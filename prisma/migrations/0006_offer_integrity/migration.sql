-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "disputeDueAt" TIMESTAMP(3),
ADD COLUMN     "disputeEvidenceTries" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "UpsellCharge" ADD COLUMN     "chargeStartedAt" TIMESTAMP(3),
ADD COLUMN     "costCents" INTEGER,
ADD COLUMN     "disputeDueAt" TIMESTAMP(3),
ADD COLUMN     "disputeEvidenceAt" TIMESTAMP(3),
ADD COLUMN     "disputeEvidenceTries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "disputeId" TEXT,
ADD COLUMN     "refundMirroredCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "whopFeeCents" INTEGER;


-- Backfill: offer refunds recorded before this migration were reported when received.
UPDATE "UpsellCharge" SET "refundMirroredCents" = "refundedCents" WHERE "shopifyOrderId" IS NOT NULL;
UPDATE "UpsellCharge" SET "chargeStartedAt" = "createdAt" WHERE "chargeStartedAt" IS NULL;
