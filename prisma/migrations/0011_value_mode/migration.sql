-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "conversionValueMode" TEXT NOT NULL DEFAULT 'revenue',
ADD COLUMN     "vatDomesticOnly" BOOLEAN NOT NULL DEFAULT false;

