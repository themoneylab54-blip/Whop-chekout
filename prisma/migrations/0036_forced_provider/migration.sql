-- « Tester le secours » (dashboard > Stripe): an admin-created test session forced to one processor.
-- Additive, nullable: every existing session keeps choosing its processor as before.

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "forcedProvider" "PaymentProvider";
