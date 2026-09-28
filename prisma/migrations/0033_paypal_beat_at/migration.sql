-- PayPal: the heartbeat of an open PayPal window (and a late popup after a "blocked" verdict).
-- Liveness only: inFlightMethod counts it, the payment.failed webhook's stale check does not (it
-- compares payClickedAt and paypalWindowAt, the real attempts). Additive: a nullable column.

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "paypalBeatAt" TIMESTAMP(3);
