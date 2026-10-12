-- What the next check of the shop's primary domain is scheduled from (lib/storefront-domain): its last
-- one, backdated for a check to make again soon. The tick asks each connected store every few hours,
-- never asked first, then the oldest checks.
ALTER TABLE "Store" ADD COLUMN "storefrontHostCheckedAt" TIMESTAMP(3);
