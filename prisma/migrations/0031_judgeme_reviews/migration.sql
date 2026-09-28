-- Judge.me private API token (encrypted), for importing reviews into the "Avis clients" block.
ALTER TABLE "Store" ADD COLUMN "judgemeApiToken" TEXT;
