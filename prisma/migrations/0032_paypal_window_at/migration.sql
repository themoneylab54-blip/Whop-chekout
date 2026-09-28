-- PayPal: when a PayPal window was last opened from Whop's own button in the embed (paypal-window
-- route). The status route counts the payment in flight from the later of this and payClickedAt,
-- so payClickedAt stays the buyer's own "Pay" click (order timeline). Additive: a nullable column.

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "paypalWindowAt" TIMESTAMP(3);
