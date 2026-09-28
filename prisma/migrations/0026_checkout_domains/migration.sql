-- Checkout domains: each store's checkout can be served on its own hostname (checkout.seyuna.com)
-- instead of APP_URL. Additive: nullable columns and a unique index (NULLs never collide).

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "checkoutDomain" TEXT,
ADD COLUMN     "checkoutDomainCheckedAt" TIMESTAMP(3),
ADD COLUMN     "checkoutDomainError" TEXT,
ADD COLUMN     "checkoutDomainVerifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Store_checkoutDomain_key" ON "Store"("checkoutDomain");
