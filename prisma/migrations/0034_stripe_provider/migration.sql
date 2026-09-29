-- Stripe (Connect, Standard accounts) as a second payment processor next to Whop.
-- Additive only: two enums, nullable columns or columns with defaults (every existing row stays
-- on Whop, every store keeps "Whop principal"), two unique indexes on new nullable columns and
-- an index to resolve the store of a Stripe Connect webhook event (event.account).

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('whop_primary', 'stripe_primary', 'stripe_only');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('whop', 'stripe');

-- AlterTable
ALTER TABLE "CheckoutQuote" ADD COLUMN     "provider" "PaymentProvider" NOT NULL DEFAULT 'whop',
ADD COLUMN     "stripePaymentIntentId" TEXT;

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "paymentProvider" "PaymentProvider" NOT NULL DEFAULT 'whop',
ADD COLUMN     "providerFeeCents" INTEGER,
ADD COLUMN     "stripeCustomerId" TEXT,
ADD COLUMN     "stripePaymentIntentId" TEXT,
ADD COLUMN     "stripePaymentMethodId" TEXT;

-- AlterTable
ALTER TABLE "RefundRecord" ADD COLUMN     "provider" "PaymentProvider" NOT NULL DEFAULT 'whop';

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "paymentMode" "PaymentMode" NOT NULL DEFAULT 'whop_primary',
ADD COLUMN     "providerFailoverAt" TIMESTAMP(3),
ADD COLUMN     "providerFailoverReason" TEXT,
ADD COLUMN     "stripeAccountId" TEXT,
ADD COLUMN     "stripeAccountName" TEXT,
ADD COLUMN     "stripeConnectedAt" TIMESTAMP(3),
ADD COLUMN     "stripeLivemode" BOOLEAN;

-- AlterTable
ALTER TABLE "UpsellCharge" ADD COLUMN     "provider" "PaymentProvider" NOT NULL DEFAULT 'whop';

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutQuote_stripePaymentIntentId_key" ON "CheckoutQuote"("stripePaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSession_stripePaymentIntentId_key" ON "CheckoutSession"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "Store_stripeAccountId_idx" ON "Store"("stripeAccountId");

