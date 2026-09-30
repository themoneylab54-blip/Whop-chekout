-- Team security (review of 0038_team_access). Additive.
-- AdminUser: the linked Google account's e-mail (shown on Profil), a short-lived marker of a fresh
-- Google re-authentication (a Google-only account setting its first password), and an e-mail change
-- awaiting confirmation from the new address (hashed token, 1 hour).
-- TeamInvite.usedById: who joined through an entry (an authorized e-mail stays reusable; its entries
-- are revoked when that member is removed, whatever its e-mail became).

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "googleEmail" TEXT,
ADD COLUMN     "pendingEmail" TEXT,
ADD COLUMN     "pendingEmailExpiresAt" TIMESTAMP(3),
ADD COLUMN     "pendingEmailTokenHash" TEXT,
ADD COLUMN     "reauthAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TeamInvite" ADD COLUMN     "usedById" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_pendingEmailTokenHash_key" ON "AdminUser"("pendingEmailTokenHash");

-- CreateIndex
CREATE INDEX "TeamInvite_usedById_idx" ON "TeamInvite"("usedById");

-- AddForeignKey
ALTER TABLE "TeamInvite" ADD CONSTRAINT "TeamInvite_usedById_fkey" FOREIGN KEY ("usedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
