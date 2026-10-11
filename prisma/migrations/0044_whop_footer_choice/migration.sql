-- The merchant's choice to clip « Propulsé par Whop » off Whop's card form on the checkout (Réglages ›
-- Whop). Off for every store: Whop treats that line as its required merchant-of-record notice.
ALTER TABLE "Store" ADD COLUMN "whopFooterHidden" BOOLEAN NOT NULL DEFAULT false;
