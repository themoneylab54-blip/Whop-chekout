-- A Stripe quote (CheckoutQuote.provider = 'stripe') holds a PaymentIntent, not a Whop checkout
-- configuration: whopCheckoutId becomes optional (still unique when set). Whop quotes unchanged.

-- AlterTable
ALTER TABLE "CheckoutQuote" ALTER COLUMN "whopCheckoutId" DROP NOT NULL;
