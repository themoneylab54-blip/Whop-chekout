-- Builder image uploads (logo, header banner, block images) stored in Postgres and served at
-- /api/public/media/<id>. Additive: a new table only.

-- CreateTable
CREATE TABLE "StoreMedia" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoreMedia_storeId_createdAt_idx" ON "StoreMedia"("storeId", "createdAt");

-- AddForeignKey
ALTER TABLE "StoreMedia" ADD CONSTRAINT "StoreMedia_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
