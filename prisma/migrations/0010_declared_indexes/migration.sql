-- Partial indexes from 0007 can't be declared in schema.prisma: a later `migrate dev`
-- would drop them silently. Replace them with nothing (the tables they served stay
-- small in practice) so the schema and the database never drift; CI checks drift.
DROP INDEX IF EXISTS "CheckoutSession_unsynced_idx";
DROP INDEX IF EXISTS "CheckoutSession_unmirrored_idx";
DROP INDEX IF EXISTS "UpsellCharge_unmirrored_idx";
