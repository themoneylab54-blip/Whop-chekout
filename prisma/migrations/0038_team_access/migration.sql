-- Team access: roles, per-store access, invitations / authorized e-mails, Google sign-in, profile.
-- Additive. AdminUser gains a role (owner | admin | viewer), a profile (name, avatarUrl), the linked
-- Google account (googleSub), allStores (false = only the stores in StoreAccess), disabledAt, the
-- session version carried by the cookie (bumped = signed out everywhere) and lastLoginAt;
-- passwordHash becomes nullable (Google-only accounts).
-- Data step: the oldest existing account becomes the owner; the others stay admin with every store,
-- so nobody loses access.

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('owner', 'admin', 'viewer');

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "allStores" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "disabledAt" TIMESTAMP(3),
ADD COLUMN     "googleSub" TEXT,
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "name" TEXT,
ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'admin',
ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "StoreAccess" (
    "userId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,

    CONSTRAINT "StoreAccess_pkey" PRIMARY KEY ("userId","storeId")
);

-- CreateTable
CREATE TABLE "TeamInvite" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'admin',
    "allStores" BOOLEAN NOT NULL DEFAULT true,
    "storeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenHash" TEXT,
    "invitedById" TEXT,
    "expiresAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoreAccess_storeId_idx" ON "StoreAccess"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamInvite_tokenHash_key" ON "TeamInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "TeamInvite_email_idx" ON "TeamInvite"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_googleSub_key" ON "AdminUser"("googleSub");

-- AddForeignKey
ALTER TABLE "StoreAccess" ADD CONSTRAINT "StoreAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreAccess" ADD CONSTRAINT "StoreAccess_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamInvite" ADD CONSTRAINT "TeamInvite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Data: the oldest account (the one created at setup) becomes the owner.
UPDATE "AdminUser" SET "role" = 'owner'
WHERE "id" = (SELECT "id" FROM "AdminUser" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1);
