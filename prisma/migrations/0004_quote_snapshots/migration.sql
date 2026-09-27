-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "paidQuoteId" TEXT,
ADD COLUMN     "reviewNote" TEXT;

-- CreateTable
CREATE TABLE "CheckoutQuote" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "whopCheckoutId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL,
    "shippingCents" INTEGER NOT NULL,
    "addOnsCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "shippingRateId" TEXT,
    "shippingRateName" TEXT,
    "shippingCountries" TEXT[],
    "discountCode" TEXT,
    "discountFreeShipping" BOOLEAN NOT NULL DEFAULT false,
    "addOns" JSONB NOT NULL,
    "addOnIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckoutQuote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutQuote_whopCheckoutId_key" ON "CheckoutQuote"("whopCheckoutId");

-- CreateIndex
CREATE INDEX "CheckoutQuote_sessionId_fingerprint_idx" ON "CheckoutQuote"("sessionId", "fingerprint");

-- AddForeignKey
ALTER TABLE "CheckoutQuote" ADD CONSTRAINT "CheckoutQuote_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CheckoutSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

