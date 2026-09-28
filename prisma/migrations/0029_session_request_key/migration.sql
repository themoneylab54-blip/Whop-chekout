-- Idempotency key of the storefront loader's session POST (a retry of the same click returns the
-- same checkout session). Additive: a nullable column and a unique index (NULLs never collide).

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN "requestKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSession_storeId_requestKey_key" ON "CheckoutSession"("storeId", "requestKey");
