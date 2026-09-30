-- « Réinitialiser l'accès » from Équipe: an owner / admin clears an active member's password and Google
-- account and sends it a fresh invitation link marked `reset`. Using that link only sets a new way in
-- (password or Google), never the member's role or stores. Additive.

-- AlterTable
ALTER TABLE "TeamInvite" ADD COLUMN     "reset" BOOLEAN NOT NULL DEFAULT false;
