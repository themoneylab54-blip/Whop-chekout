-- Round 17 (reliability): backoff of the merged offers' balance retries (nextBalanceAt, like the order
-- sync's nextSyncAt) and a lease on the fraud-alert refund (alertRefundStartedAt: the webhook's
-- after-response run and the tick's retry never send it concurrently). Additive: nullable columns.

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "alertRefundStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "UpsellCharge" ADD COLUMN     "nextBalanceAt" TIMESTAMP(3);
