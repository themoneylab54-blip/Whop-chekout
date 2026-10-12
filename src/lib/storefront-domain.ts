import "server-only";
import { domainToUnicode } from "node:url";
import type { Store } from "@prisma/client";
import { db } from "./db";
import { DeadlineError, notePartial, stopForTime } from "./deadline";
import { log, recordEvent } from "./log";
import { rateLimit, rateLimitReached } from "./ratelimit";
import { getShopInfo, ShopifyError } from "./shopify";
import { CALL_RESERVE_MS } from "./shopify-history";
import { shopHostname } from "./shop-host";

/*
 * The shop's storefront domain kept as Shopify has it now (its primary domain). The checkout's links
 * back to the shop (« Retour au panier », the thank-you page's link to the shop, the checkout domain's
 * root) and the return URLs it accepts start from it: a shop moved to another domain (sovéline.fr →
 * soveline.fr) would otherwise send buyers to a domain that no longer answers, until the merchant
 * reconnected Shopify. (The cart re-read never starts there: it asks the shop's *.myshopify.com
 * address, see readCartJs.) Asked of Shopify by the tick every few hours per store (never asked first,
 * then the oldest checks), whenever the dashboard reads the connection's live status, and soon after a
 * buyer's checkout comes from a host the store doesn't know (that host is never trusted, only a reason
 * to ask Shopify). Saved in one form (shopHostname), a value saved in another one rewritten at its next
 * check.
 */

/** How often the tick asks Shopify, per store. */
export const DOMAIN_CHECK_EVERY_MS = 6 * 3600_000;
/** A check to make again soon instead: a new domain waiting for its certificate, Shopify briefly unavailable. */
export const DOMAIN_RECHECK_SOON_MS = 30 * 60_000;
/** How often checkouts from hosts the store doesn't know may make it ask, per store… */
export const DOMAIN_RECHECK_MS = 10 * 60_000;
/** …and about the same host: one that stays unknown (a Markets or preview domain, not the primary one) asks again only this late. */
export const UNKNOWN_HOST_RECHECK_MS = 6 * 3600_000;
/** Stores the tick checks per run at most. */
export const DOMAIN_CHECKS_PER_RUN = 10;

type DomainStore = Pick<Store, "id" | "shopDomain" | "shopifyAccessToken" | "storefrontHost">;
type Why = "tick" | "unknown_host" | "dashboard";
/** Shopify's primary domain of a shop (sslEnabled: its certificate issued; left out by older answers). */
export type PrimaryDomain = { host: string; sslEnabled?: boolean } | null | undefined;

/** A domain for people: an accented domain with its accents (xn--sovline-dya.fr → sovéline.fr). */
export function shopHostLabel(host: string): string {
  return domainToUnicode(host) || host;
}

/**
 * What Shopify's primary domain says: its hostname (see shopHostname), and whether its certificate is
 * still to be issued (Shopify provisions it after a domain change; links to it would fail over https
 * meanwhile, so it isn't adopted yet). Pure.
 */
export function readPrimaryDomain(primary: PrimaryDomain): { host: string | null; sslPending: boolean } {
  const host = shopHostname(primary?.host);
  return { host, sslPending: !!host && primary?.sslEnabled === false };
}

/**
 * The value recorded for a check (storefrontHostCheckedAt, what the next one is scheduled from): now,
 * or — a check to make again soon — the time that makes the store due DOMAIN_RECHECK_SOON_MS from now.
 * Pure.
 */
export function checkTime(soon: boolean, now = Date.now()): Date {
  return new Date(soon ? now - DOMAIN_CHECK_EVERY_MS + DOMAIN_RECHECK_SOON_MS : now);
}

/**
 * The store's domain at a Shopify (re)connection, from the shop's primary domain, the check done now.
 * Its certificate not issued yet: `kept` — the domain saved for that same shop (null for a first
 * connection or another shop: the links use the *.myshopify.com address) — as a check keeps it, and the
 * check due again soon. Pure.
 */
export function connectionDomainFields(primary: PrimaryDomain, kept: string | null, now = Date.now()): { storefrontHost: string | null; storefrontHostCheckedAt: Date } {
  const { host, sslPending } = readPrimaryDomain(primary);
  const waiting = sslPending && host !== shopHostname(kept);
  return { storefrontHost: waiting ? shopHostname(kept) : host, storefrontHostCheckedAt: checkTime(waiting, now) };
}

/**
 * Saves `host` as the store's storefront domain when it changed, journaled for the store; the same
 * domain saved in another form (capitals, accents) is rewritten in this one, not journaled. Only over
 * the connection read: same shop, same access token, same domain as read — a reconnection meanwhile
 * (to the same shop or another) wins, its domain is never replaced by the previous shop's. True when
 * the domain changed.
 */
export async function saveStorefrontHost(store: DomainStore, host: string, why: Why): Promise<boolean> {
  if (store.storefrontHost === host) return false;
  const before = shopHostname(store.storefrontHost);
  const { count } = await db.store.updateMany({
    where: { id: store.id, shopDomain: store.shopDomain, shopifyAccessToken: store.shopifyAccessToken, storefrontHost: store.storefrontHost },
    data: { storefrontHost: host },
  });
  if (!count || host === before) return false;
  await recordEvent({
    storeId: store.id,
    level: "info",
    kind: "shopify.storefront_domain",
    message: `Domaine de la boutique mis à jour : ${before ? shopHostLabel(before) : "aucun"} → ${shopHostLabel(host)} (liens « Retour au panier » du checkout, adresses de retour acceptées).`,
    data: { from: before, to: host, why },
  });
  return true;
}

/**
 * The primary domain Shopify just gave for the store: saved (saveStorefrontHost) unless it is a new
 * one still waiting for its certificate (the domain saved kept meanwhile, the check made again soon),
 * the check recorded (checkTime). True when the domain changed.
 */
async function applyPrimaryDomain(store: DomainStore, primary: PrimaryDomain, why: Why): Promise<boolean> {
  const { host, sslPending } = readPrimaryDomain(primary);
  const waiting = sslPending && host !== shopHostname(store.storefrontHost);
  const changed = !!host && !waiting && (await saveStorefrontHost(store, host, why));
  await db.store.updateMany({ where: { id: store.id }, data: { storefrontHostCheckedAt: checkTime(waiting) } });
  return changed;
}

/**
 * One check: Shopify asked for the shop's primary domain, then applyPrimaryDomain. Throws DeadlineError
 * only (a bounded run out of time, Shopify's breaker open for the run): nothing recorded, the store
 * comes first next run. Any other failure is logged and recorded: Shopify briefly unavailable (a
 * transient ShopifyError), asked again soon; else (the access revoked, an error of Shopify's), at the
 * next due time.
 */
async function checkStorefrontHost(store: DomainStore, why: Why): Promise<boolean> {
  let primary: PrimaryDomain;
  try {
    primary = (await getShopInfo(store)).primaryDomain;
  } catch (err) {
    if (err instanceof DeadlineError) throw err;
    log.warn("shopify.storefront_domain_failed", "Could not read the shop's primary domain", { storeId: store.id, why, err });
    const soon = err instanceof ShopifyError && err.transient;
    await db.store.updateMany({ where: { id: store.id }, data: { storefrontHostCheckedAt: checkTime(soon) } }).catch(() => undefined);
    return false;
  }
  try {
    return await applyPrimaryDomain(store, primary, why);
  } catch (err) {
    log.warn("shopify.storefront_domain_failed", "Could not save the shop's primary domain", { storeId: store.id, why, err });
    return false;
  }
}

/**
 * A checkout from `host` (an https URL's hostname), which the store doesn't know: Shopify asked again
 * (the shop may have moved), at most every DOMAIN_RECHECK_MS per store and UNKNOWN_HOST_RECHECK_MS per
 * host. A host asked about lately spends nothing (its limit is only looked at); else the store's limit
 * is spent first, so rows per host are only ever written within it. Never throws.
 */
export async function recheckStorefrontHost(store: DomainStore, host: string): Promise<void> {
  try {
    if (!store.shopDomain || !store.shopifyAccessToken) return;
    const hostKey = `storefront-domain:${store.id}:${host}`;
    if (await rateLimitReached(hostKey, 1)) return;
    if (!(await rateLimit(`storefront-domain:${store.id}`, 1, DOMAIN_RECHECK_MS))) return;
    if (!(await rateLimit(hostKey, 1, UNKNOWN_HOST_RECHECK_MS))) return;
    await checkStorefrontHost(store, "unknown_host");
  } catch (err) {
    log.warn("shopify.storefront_domain_failed", "Could not recheck the shop's primary domain", { storeId: store.id, why: "unknown_host", err });
  }
}

/**
 * The primary domain the dashboard's live status just read from Shopify (no call of its own), applied
 * as a check's (applyPrimaryDomain). Never throws.
 */
export async function noteStorefrontPrimary(store: DomainStore, primary: PrimaryDomain): Promise<void> {
  try {
    await applyPrimaryDomain(store, primary, "dashboard");
  } catch (err) {
    log.warn("shopify.storefront_domain_failed", "Could not save the shop's primary domain", { storeId: store.id, why: "dashboard", err });
  }
}

/**
 * The tick's job: the connected stores last checked more than DOMAIN_CHECK_EVERY_MS ago (never checked
 * first, then the oldest checks), DOMAIN_CHECKS_PER_RUN at most, one after the other while the run has
 * time for a Shopify call (CALL_RESERVE_MS). Out of time or Shopify's breaker open: stopped and noted
 * partial, those stores first next run (nothing recorded for them). Returns the stores checked.
 */
export async function checkStorefrontDomains(deadline: number, now = new Date()): Promise<number> {
  const stores = await db.store.findMany({
    where: {
      shopifyConnectedAt: { not: null },
      shopDomain: { not: null },
      shopifyAccessToken: { not: null },
      OR: [{ storefrontHostCheckedAt: null }, { storefrontHostCheckedAt: { lt: new Date(now.getTime() - DOMAIN_CHECK_EVERY_MS) } }],
    },
    orderBy: { storefrontHostCheckedAt: { sort: "asc", nulls: "first" } },
    select: { id: true, shopDomain: true, shopifyAccessToken: true, storefrontHost: true },
    take: DOMAIN_CHECKS_PER_RUN,
  });
  let checked = 0;
  for (const store of stores) {
    if (stopForTime(deadline, CALL_RESERVE_MS)) break;
    try {
      await checkStorefrontHost(store, "tick");
    } catch (err) {
      if (!(err instanceof DeadlineError)) throw err;
      notePartial();
      break;
    }
    checked++;
  }
  return checked;
}
