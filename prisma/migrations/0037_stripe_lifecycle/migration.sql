-- Stripe connection lifecycle and money flow. Additive only, nullable columns (no default, no backfill):
--   Store.stripeChargesEnabled      the connected account can take payments (charges_enabled); null = unknown
--   Store.lastStripeWebhookAt       last Stripe Connect webhook event received for the store
--   CheckoutSession.stripeAccountId the connected account the session's PaymentIntent lives on (refunds,
--                                   disputes and reconciliation keep working after a disconnect / replace)
--   CheckoutSession.stripeOffSessionSaved the buyer's card was saved off-session (one-click offers)

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "stripeAccountId" TEXT,
ADD COLUMN     "stripeOffSessionSaved" BOOLEAN;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "lastStripeWebhookAt" TIMESTAMP(3),
ADD COLUMN     "stripeChargesEnabled" BOOLEAN;
