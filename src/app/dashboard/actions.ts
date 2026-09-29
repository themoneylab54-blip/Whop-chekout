"use server";

import { providerRefundAmount } from "@/lib/charge";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { rateLimit } from "@/lib/ratelimit";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { login, logout, requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { EU_VAT_AREA, STANDARD_VAT_RATES } from "@/lib/vat";
import { decrypt, encrypt, randomToken } from "@/lib/crypto";
import {
  checkoutLayoutSchema,
  interceptionSchema,
  themeSchema,
  thankYouLayoutSchema,
  type Layout,
  type Theme,
} from "@/lib/layout";
import { ensureScriptTag, installUrl, normalizeShopDomain, removeScriptTag } from "@/lib/shopify";
import { OPTIONAL_PAYMENT_METHOD_IDS, refundPayment, registerApplePayDomain, setupWhop, statementDescriptor, teardownWhop } from "@/lib/whop";
import { testConversions } from "@/lib/conversions";
import { draftDesign, hasPublished, publishedDesign, sameDesign } from "@/lib/design";
import { log, recordEvent } from "@/lib/log";
import { CLONE_TX, copyMedia, lockStore, missingMediaIds, planMediaCopy, remapMediaIds, withoutMissingMedia } from "@/lib/media";
import { buyerEmailAvailable, OPERATOR_FROM_SETTING, OPERATOR_KEY_SETTING, sendAlert } from "@/lib/notify";
import { isStorableTimeZone } from "@/lib/time-db";
import { addDays, tzOf, zonedDayStart } from "@/lib/time";
import { env } from "@/lib/env";
import { clearPaypalRefusals, syncOrder, syncOrderSafely, syncSkipMessage, type SyncSkipReason } from "@/lib/checkout";
import { centsToDecimal, MAX_GIFT_TIERS, MAX_PERCENT_TIERS, validateQuantityTiers } from "@/lib/pricing";
import { pickupConfigured, searchPickupPoints } from "@/lib/pickup";
import { cleanRecordI18n } from "@/components/checkout/localize";
import { recordValueModeChange } from "@/lib/value-mode";
import { closeFallbackPeriod, recordCheckoutEnabled } from "@/lib/fallback";
import { buyerName, sessionIdsByBuyerName } from "@/lib/order-search";
import { flashUrl, issueField, type FlashParams } from "@/lib/flash";
import { checkoutHostOf, formatDomainError, normalizeCheckoutDomain, parseDomainError } from "@/lib/checkout-domain";
import { APPLE_PAY_ASSOCIATION_KEY, checkStoreDomain, reregisterApplePayDomain, retireCheckoutDomain, retiredDomainOwner, unretireCheckoutDomain } from "@/lib/checkout-domain-check";
import { addProjectDomain, getProjectDomain, VercelApiError, vercelConfig, type VercelConfig } from "@/lib/vercel-domains";
import { deauthorize as deauthorizeStripe, refundStripe, registerStripeDomain, stripeConfigured, stripeForMode, stripeModeOf, stripeWalletHosts } from "@/lib/stripe";
import {
  disconnectBlockMessage,
  ensureStripeWebhook,
  forgetStripeAccount,
  markPastStripeAccountRevoked,
  pastStripeAccounts,
  sessionStripeAccount,
  stripeConnectionMode,
  stripeDisconnectBlockers,
} from "@/lib/stripe-connection";
import { anyProviderConnected, PAYMENT_MODE_LABELS, paymentModeProblem, providerConnected, storeReady, stripeUnusableReason } from "@/lib/payment-provider";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Redirects back with a flash; a validation error names its `field` (shown inline, typed values restored). */
function back(path: string, params: FlashParams = {}): never {
  redirect(flashUrl(path, params));
}

function storePath(storeId: string, sub = "") {
  return `/dashboard/stores/${storeId}${sub ? `/${sub}` : ""}`;
}

async function getStore(storeId: string) {
  await requireAdmin();
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store) redirect("/dashboard");
  return store;
}

function str(fd: FormData, key: string) {
  return String(fd.get(key) ?? "").trim();
}

/** Largest amount accepted anywhere in the dashboard (1 000 000.00). */
const MAX_CENTS = 100_000_000;

/** "12,50" | "12.5" | "12" → 1250 cents. Returns null when empty, invalid or absurdly large. */
function cents(value: string): number | null {
  if (!value) return null;
  const compact = value.replace(/\s/g, "");
  // "12,505" is refused rather than silently rounded to 12,51.
  if (!/^\d*(?:[.,]\d{0,2})?$/.test(compact) || !/\d/.test(compact)) return null;
  const n = Number(compact.replace(",", "."));
  return Number.isFinite(n) && n >= 0 && n * 100 <= MAX_CENTS ? Math.round(n * 100) : null;
}

/** Encrypts before any external call so a misconfigured key fails cleanly, with nothing half-created. */
function encryptOrBack(value: string, path: string): string {
  try {
    return encrypt(value);
  } catch (err) {
    log.error("crypto.encrypt_failed", "Could not encrypt a secret (ENCRYPTION_KEY?)", { err });
    back(path, { error: `Chiffrement impossible : ${errorMessage(err)}` });
  }
}

function errorMessage(err: unknown) {
  if (err && typeof err === "object" && "body" in err) {
    const body = (err as { body?: { error?: { message?: string }; message?: string } }).body;
    const msg = body?.error?.message ?? body?.message;
    if (msg) return msg;
  }
  return err instanceof Error ? err.message : "Erreur inconnue";
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

export type LoginState = { error?: string; email?: string };

/** Used with useActionState: a failed attempt returns the error and keeps the typed e-mail. */
export async function loginAction(_prev: LoginState, fd: FormData): Promise<LoginState> {
  const email = str(fd, "email").slice(0, 200);
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!(await rateLimit(`login:${ip}`, 10))) return { error: "Trop de tentatives. Réessayez dans une minute.", email };
  const ok = await login(email, String(fd.get("password") ?? ""));
  if (!ok) return { error: "E-mail ou mot de passe incorrect", email };
  // A single store: land directly on it instead of the store list.
  const stores = await db.store.findMany({ select: { id: true }, take: 2 });
  redirect(stores.length === 1 ? storePath(stores[0].id) : "/dashboard");
}

export async function logoutAction() {
  await logout();
  redirect("/login");
}

/* ------------------------------------------------------------------ */
/* Stores                                                              */
/* ------------------------------------------------------------------ */

export async function createStoreAction(fd: FormData) {
  await requireAdmin();
  const name = str(fd, "name").slice(0, 80) || "Nouvelle boutique";
  const store = await db.store.create({ data: { name } });
  redirect(storePath(store.id, "shopify"));
}

export async function deleteStoreAction(storeId: string) {
  const store = await getStore(storeId);
  // Paid orders are accounting records: never erase them by accident.
  const paid = await db.checkoutSession.count({ where: { storeId, status: "PAID" } });
  if (paid > 0) {
    back(storePath(storeId, "settings"), {
      error: `Cette boutique a ${paid} commande(s) payée(s) : désactivez le checkout au lieu de la supprimer.`,
    });
  }
  if (store.scriptTagId && store.shopifyAccessToken) {
    await removeScriptTag(store, store.scriptTagId).catch(() => undefined);
  }
  await teardownWhop(store).catch(() => undefined);
  // Removed from Vercel after the usual 48 h grace (tick), like a changed or removed domain.
  if (store.checkoutDomain) await retireCheckoutDomain(storeId, store.checkoutDomain).catch(() => undefined);
  await db.store.delete({ where: { id: storeId } });
  redirect("/dashboard");
}

/** Published JSON setting → create input (null stays unset). */
const jsonCopy = (v: Prisma.JsonValue | null) => (v === null ? undefined : (v as Prisma.InputJsonValue));

/**
 * "Cloner la boutique": a new, unconnected store with this store's configuration (design and its
 * uploaded images, interception, shipping rates, add-ons, discount codes with fresh counters, quantity breaks,
 * costs & VAT, pixel IDs, alerts, safety net, conversion value). Never copied: Shopify / Whop
 * connections, pixel tokens, Mondial Relay credentials, the bank statement label, orders and
 * stats; the copy starts offline, in test mode, with its own publicId.
 */
export async function cloneStoreAction(storeId: string) {
  const src = await getStore(storeId);
  const [rates, addOns, discounts] = await Promise.all([
    db.shippingRate.findMany({ where: { storeId }, orderBy: { position: "asc" } }),
    db.addOn.findMany({ where: { storeId }, orderBy: { position: "asc" } }),
    db.discountCode.findMany({ where: { storeId }, orderBy: { createdAt: "asc" } }),
  ]);
  const name = `${src.name.slice(0, 72)} (copie)`;
  // Uploaded images (logo, banner, block images) are copied too, under new ids the copied design
  // points to: deleting one in either store never breaks the other. Planned under the source's Store
  // row lock (as image deletes take), and an image the source no longer has is emptied: the copy
  // never points to an image that wasn't copied.
  let mediaCount = 0;
  let copy: { id: string };
  try {
    copy = await db.$transaction(async (tx) => {
      await lockStore(tx, storeId);
      const media = await planMediaCopy(storeId, tx);
      mediaCount = media.size;
      const design = async <T,>(v: T) => remapMediaIds(await withoutMissingMedia(tx, storeId, v), media);
      const theme = jsonCopy(await design(src.theme));
      const checkoutLayout = jsonCopy(await design(src.checkoutLayout));
      const thankYouLayout = jsonCopy(await design(src.thankYouLayout));
      const addOnImages: (string | null)[] = [];
      for (const a of addOns) addOnImages.push(await design(a.imageUrl));
      const created = await tx.store.create({
        data: {
          name,
          testMode: true,
          enabled: false,
          shopCurrency: src.shopCurrency,
          theme,
          checkoutLayout,
          thankYouLayout,
          interception: jsonCopy(src.interception),
          publishedAt: src.checkoutLayout ? new Date() : null,
          paymentMethods: src.paymentMethods,
          quantityBreaks: jsonCopy(src.quantityBreaks),
          // Costs & VAT
          fulfillmentFeeCents: src.fulfillmentFeeCents,
          disputeFeeCents: src.disputeFeeCents,
          fixedCostsMonthlyCents: src.fixedCostsMonthlyCents,
          vatExempt: src.vatExempt,
          vatDomesticOnly: src.vatDomesticOnly,
          homeCountry: src.homeCountry,
          adSpendVatNonReclaimable: src.adSpendVatNonReclaimable,
          // One-click offers merged into the checkout's order (opt-in) and its window
          mergeOffersIntoOrder: src.mergeOffersIntoOrder,
          offerMergeWindowMin: src.offerMergeWindowMin,
          // Checkout options (the e-mail code needs this store's own Resend key: not copied)
          shopifyDiscountCodes: src.shopifyDiscountCodes,
          chargeLocalCurrency: src.chargeLocalCurrency,
          // Pixels: IDs and options only, never the access tokens
          metaPixelId: src.metaPixelId,
          tiktokPixelId: src.tiktokPixelId,
          ga4MeasurementId: src.ga4MeasurementId,
          pixelRequireConsent: src.pixelRequireConsent,
          metaContentIdFormat: src.metaContentIdFormat,
          metaCatalogCountry: src.metaCatalogCountry,
          conversionValueMode: src.conversionValueMode,
          // Alerts (the operator's own channels)
          alertEmail: src.alertEmail,
          emailFrom: src.emailFrom,
          resendApiKey: src.resendApiKey,
          telegramBotToken: src.telegramBotToken,
          telegramChatId: src.telegramChatId,
          // Safety net & dispute shield
          autoFallback: src.autoFallback,
          pushTracking: src.pushTracking,
          autoDisputeEvidence: src.autoDisputeEvidence,
          autoRefundFraudAlerts: src.autoRefundFraudAlerts,
          shippingRates: {
            create: rates.map((r) => ({
              name: r.name,
              deliveryTime: r.deliveryTime,
              countries: r.countries,
              priceCents: r.priceCents,
              freeOverCents: r.freeOverCents,
              position: r.position,
              active: r.active,
              costCents: r.costCents,
              kind: r.kind,
            })),
          },
          addOns: {
            create: addOns.map((a, i) => ({
              title: a.title,
              description: a.description,
              priceCents: a.priceCents,
              variantId: a.variantId,
              imageUrl: addOnImages[i],
              position: a.position,
              active: a.active,
              costCents: a.costCents,
              showIf: jsonCopy(a.showIf),
            })),
          },
          discounts: {
            create: discounts.map((d) => ({
              code: d.code,
              type: d.type,
              value: d.value,
              minSubtotalCents: d.minSubtotalCents,
              startsAt: d.startsAt,
              endsAt: d.endsAt,
              usageLimit: d.usageLimit,
              usageCount: 0,
              active: d.active,
            })),
          },
        },
        select: { id: true },
      });
      await copyMedia(tx, storeId, created.id, media);
      return created;
    }, CLONE_TX); // up to 50 images copied in SQL plus the store's rows: past Prisma's 5 s default
  } catch (err) {
    log.error("store.clone_failed", "Store clone failed", { storeId, err });
    back(storePath(storeId, "settings"), { error: `Duplication impossible : ${errorMessage(err)}` });
  }
  const counts = { shippingRates: rates.length, addOns: addOns.length, discounts: discounts.length, media: mediaCount };
  await Promise.all([
    recordEvent({
      storeId,
      kind: "store.cloned_to",
      message: `Configuration dupliquée vers une nouvelle boutique « ${name} ».`,
      data: { newStoreId: copy.id, ...counts },
    }),
    recordEvent({
      storeId: copy.id,
      kind: "store.cloned_from",
      message: `Boutique créée par duplication de « ${src.name} » : design, livraison, options, codes promo, coûts, pixels (sans jetons) et alertes copiés. Shopify et Whop restent à connecter.`,
      data: { sourceStoreId: storeId, ...counts },
    }),
  ]);
  revalidatePath("/dashboard", "layout");
  back(storePath(copy.id), { ok: `Configuration de « ${src.name} » copiée. Connectez Shopify puis Whop pour mettre cette boutique en ligne.` });
}

export async function saveSettingsAction(storeId: string, fd: FormData) {
  const store = await getStore(storeId);
  const testMode = fd.get("testMode") === "on";
  const name = str(fd, "name").slice(0, 80) || store.name;
  // Time zone of the store's days and hours (analytics, reports, alerts); an unknown name keeps the current one.
  const tzRaw = str(fd, "timezone");
  // Postgres must know it too (analytics inline it in SQL): checked against pg_timezone_names.
  if (tzRaw && tzRaw !== store.timezone && !(await isStorableTimeZone(tzRaw))) back(storePath(storeId, "settings"), { error: `Fuseau horaire inconnu : ${tzRaw.slice(0, 64)}`, field: "timezone" });
  const timezone = tzRaw || store.timezone;
  const modeChanged = testMode !== store.testMode;
  if (modeChanged && store.whopConnectedAt) {
    // Sandbox and production use different Whop keys: the connection must be redone.
    await teardownWhop(store).catch(() => undefined);
  }
  // The store as the new mode leaves it: Whop to reconnect, no failover; the checkout stays live only
  // when a processor can still charge (a Stripe connection covering the new mode).
  const next = { ...store, testMode, providerFailoverAt: null, ...(modeChanged && store.whopConnectedAt ? { whopConnectedAt: null } : {}) };
  const noProcessorLeft = modeChanged && !anyProviderConnected(next);
  const stripeKeeps = modeChanged && providerConnected(next, "stripe");
  await db.store.update({
    where: { id: storeId },
    data: {
      name,
      testMode,
      timezone,
      // A processor failover belongs to the previous mode's connections: the new mode starts clean.
      ...(modeChanged ? { providerFailoverAt: null, providerFailoverReason: null } : {}),
      ...(noProcessorLeft ? { enabled: false } : {}),
      ...(modeChanged && store.whopConnectedAt
        ? {
            whopApiKey: null,
            whopAccountId: null,
            whopProductId: null,
            whopWebhookId: null,
            whopWebhookSecret: null,
            whopConnectedAt: null,
          }
        : {}),
    },
  });
  if (noProcessorLeft) await recordCheckoutEnabled(storeId, store.enabled, false, "Mode test / production changé");
  // Stripe still charging in the new mode: its Connect webhook and wallet domains are the new mode's
  // (another platform key), set up now rather than at the first payment.
  let stripeSetupNote = "";
  if (stripeKeeps) {
    const webhook = await ensureStripeWebhook(storeId, stripeModeOf(next));
    const domains = await registerWalletDomains(next);
    stripeSetupNote = `${webhook ? ` Webhook Stripe du nouveau mode à réparer : ${webhook}.` : ""}${domains.failed.length ? ` Apple Pay pas enregistré chez Stripe : ${domains.failed.join(", ")} (bouton « Enregistrer les domaines » sur la page Stripe).` : ""}`;
  }
  // Stripe: a connection made in test mode can't charge in production (a live one covers both).
  const stripeNote =
    modeChanged && !testMode && store.stripeAccountId && store.stripeLivemode !== true ? " Reconnectez Stripe en production : ce compte Stripe a été connecté en mode test et ne peut pas encaisser en production." : "";
  const liveNote = modeChanged && store.enabled && !noProcessorLeft && store.whopConnectedAt ? " Le checkout reste en ligne : Stripe encaisse en attendant." : "";
  if (modeChanged) {
    await recordEvent({
      storeId,
      level: stripeNote || stripeSetupNote ? "warn" : "info",
      kind: "store.mode_changed",
      message: `Mode ${testMode ? "test" : "production"} activé depuis les réglages.${store.whopConnectedAt ? " Whop est à reconnecter." : ""}${liveNote}${stripeNote}${stripeSetupNote}${store.providerFailoverAt ? " La bascule de processeur en cours est levée." : ""}`,
      data: { testMode, stripeReconnect: !!stripeNote, disabled: noProcessorLeft && store.enabled },
    });
  }
  revalidatePath(storePath(storeId), "layout");
  if (modeChanged && store.whopConnectedAt) {
    // The switch itself succeeded; a Stripe problem it leaves is said apart, as an error.
    const stripeProblem = `${stripeNote}${stripeSetupNote}`.trim();
    back(storePath(storeId, "whop"), {
      ok: `Mode ${testMode ? "test" : "production"} activé. Reconnectez Whop avec la clé ${testMode ? "sandbox" : "de production"}.${liveNote}`,
      ...(stripeProblem ? { error: stripeProblem } : {}),
    });
  }
  if (stripeNote) back(storePath(storeId, "stripe"), { ok: "Mode production activé.", error: `${stripeNote}${stripeSetupNote}`.trim() });
  if (stripeSetupNote) back(storePath(storeId, "stripe"), { ok: `Mode ${testMode ? "test" : "production"} activé.`, error: stripeSetupNote.trim() });
  back(storePath(storeId, "settings"), { ok: "Réglages enregistrés" });
}

export async function setEnabledAction(storeId: string, enabled: boolean) {
  const store = await getStore(storeId);
  // Live = Shopify connected and at least one processor able to charge under the payment mode (Whop,
  // or Stripe alone: a Stripe-only store never needs Whop).
  if (enabled && !storeReady(store)) {
    back(storePath(storeId), { error: "Connectez Shopify et un moyen de paiement (Whop ou Stripe) avant d'activer le checkout." });
  }
  await db.store.update({ where: { id: storeId }, data: { enabled } });
  // Charts show the hours the checkout was off (sales on Shopify's checkout, outside these figures).
  await recordCheckoutEnabled(storeId, store.enabled, enabled, enabled ? null : "Checkout désactivé à la main");
  revalidatePath(storePath(storeId), "layout");
  back(storePath(storeId), {
    ok: enabled ? "Checkout activé sur la boutique" : "Checkout désactivé : la boutique utilise le checkout Shopify.",
  });
}

/* ------------------------------------------------------------------ */
/* Shopify connection                                                  */
/* ------------------------------------------------------------------ */

export async function startShopifyInstallAction(storeId: string, fd: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "shopify");
  const shop = normalizeShopDomain(str(fd, "shopDomain"));
  if (!shop) back(path, { error: "Domaine invalide : utilisez l'adresse en .myshopify.com", field: "shopDomain" });

  const clientId = str(fd, "clientId") || store.shopifyClientId || "";
  const clientSecret = str(fd, "clientSecret");
  if (!clientId) back(path, { error: "Client ID manquant", field: "clientId" });
  if (!clientSecret && !store.shopifyClientSecret) back(path, { error: "Client secret manquant", field: "clientSecret" });

  const other = await db.store.findFirst({ where: { shopDomain: shop, NOT: { id: storeId } } });
  if (other) back(path, { error: `${shop} est déjà connectée à la boutique « ${other.name} ».`, field: "shopDomain" });

  const encryptedSecret = clientSecret ? encryptOrBack(clientSecret, path) : null;
  const state = `${storeId}.${randomToken()}`;
  const domainChanged = store.shopDomain && store.shopDomain !== shop;
  if (domainChanged && store.scriptTagId && store.shopifyAccessToken) {
    await removeScriptTag(store, store.scriptTagId).catch(() => undefined);
  }
  await db.store.update({
    where: { id: storeId },
    data: {
      shopDomain: shop,
      shopifyClientId: clientId,
      ...(encryptedSecret ? { shopifyClientSecret: encryptedSecret } : {}),
      shopifyOauthState: state,
      ...(domainChanged
        ? // The Judge.me token belongs to the previous shop's .myshopify.com domain: forgotten with it.
          { shopifyAccessToken: null, scriptTagId: null, shopifyConnectedAt: null, enabled: false, storefrontHost: null, judgemeApiToken: null }
        : {}),
    },
  });
  if (domainChanged) await recordCheckoutEnabled(storeId, store.enabled, false, "Boutique Shopify changée");
  redirect(installUrl(shop, clientId, state));
}

export async function disconnectShopifyAction(storeId: string) {
  const store = await getStore(storeId);
  if (store.scriptTagId && store.shopifyAccessToken) {
    await removeScriptTag(store, store.scriptTagId).catch(() => undefined);
  }
  await db.store.update({
    where: { id: storeId },
    // The Judge.me token is tied to this shop's .myshopify.com domain: forgotten with it.
    data: { shopifyAccessToken: null, scriptTagId: null, shopifyConnectedAt: null, shopifyScopes: null, enabled: false, judgemeApiToken: null },
  });
  await recordCheckoutEnabled(storeId, store.enabled, false, "Shopify déconnecté");
  revalidatePath(storePath(storeId), "layout");
  back(storePath(storeId, "shopify"), { ok: "Boutique déconnectée et script retiré." });
}

export async function reinstallScriptAction(storeId: string) {
  const store = await getStore(storeId);
  try {
    const scriptTagId = await ensureScriptTag(store);
    await db.store.update({ where: { id: storeId }, data: { scriptTagId } });
  } catch (err) {
    back(storePath(storeId, "interception"), { error: errorMessage(err) });
  }
  back(storePath(storeId, "interception"), { ok: "Script vérifié et installé sur la boutique" });
}

/* ------------------------------------------------------------------ */
/* Whop connection                                                     */
/* ------------------------------------------------------------------ */

export async function connectWhopAction(storeId: string, fd: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "whop");
  const apiKey = str(fd, "apiKey");
  if (!apiKey) back(path, { error: "Collez votre clé API Whop", field: "apiKey" });
  const encryptedKey = encryptOrBack(apiKey, path);
  let result;
  try {
    // Set up with the new key first: a wrong key must not break a working connection.
    result = await setupWhop({
      apiKey,
      testMode: store.testMode,
      storeId,
      storeName: store.name,
      statementDescriptor: store.statementDescriptor,
    });
  } catch (err) {
    back(path, { error: `Whop a refusé la connexion : ${errorMessage(err)}`, field: "apiKey" });
  }
  if (store.whopConnectedAt && store.whopWebhookId && store.whopWebhookId !== result.webhookId) {
    await teardownWhop(store).catch(() => undefined);
  }
  await db.store.update({
    where: { id: storeId },
    data: {
      whopApiKey: encryptedKey,
      whopAccountId: result.accountId,
      whopProductId: result.productId,
      whopWebhookId: result.webhookId,
      whopWebhookSecret: encryptOrBack(result.webhookSecret, path),
      whopConnectedAt: new Date(),
    },
  });
  // A new key or account: its Apple Pay domains start empty.
  await reregisterApplePayDomain(storeId);
  revalidatePath(storePath(storeId), "layout");
  // Several stores on one Whop account work (each has its own product), but its events
  // reach every store: say so, so "événement d'une autre boutique" lines don't surprise.
  const siblings = await db.store.findMany({ where: { whopAccountId: result.accountId, id: { not: storeId } }, select: { name: true }, take: 5 });
  const shared = siblings.length
    ? ` Attention : ce compte Whop est aussi connecté à ${siblings.map((x) => `« ${x.name} »`).join(", ")}. Chaque boutique a son propre produit Whop ; les paiements, remboursements et litiges de l'autre boutique arrivent aussi ici et sont ignorés automatiquement (ligne d'information dans le journal).`
    : "";
  back(path, { ok: `Compte Whop « ${result.accountName} » connecté. Produit et webhook créés automatiquement.${shared}` });
}

export async function disconnectWhopAction(storeId: string) {
  const store = await getStore(storeId);
  await teardownWhop(store).catch(() => undefined);
  // Stripe able to charge on its own: the checkout stays live on it; otherwise buyers go back to Shopify's.
  const noProcessorLeft = !anyProviderConnected({ ...store, whopConnectedAt: null });
  await db.store.update({
    where: { id: storeId },
    data: {
      ...(noProcessorLeft ? { enabled: false } : {}),
      whopApiKey: null,
      whopAccountId: null,
      whopProductId: null,
      whopWebhookId: null,
      whopWebhookSecret: null,
      whopConnectedAt: null,
    },
  });
  if (noProcessorLeft) await recordCheckoutEnabled(storeId, store.enabled, false, "Whop déconnecté");
  revalidatePath(storePath(storeId), "layout");
  back(storePath(storeId, "whop"), { ok: store.enabled && !noProcessorLeft ? "Whop déconnecté. Le checkout reste en ligne : Stripe encaisse seul." : "Whop déconnecté." });
}

/* ------------------------------------------------------------------ */
/* Stripe connection                                                   */
/* ------------------------------------------------------------------ */

/**
 * « Déconnecter » Stripe: the platform lets go of the account (unless another store uses it, with the
 * keys of the mode it was connected in), the store forgets it. Refused while Stripe payments are in
 * flight or recent ones still lack their Shopify order, unless « Déconnecter quand même » is ticked.
 */
export async function disconnectStripeAction(storeId: string, fd?: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "stripe");
  if (!store.stripeAccountId) back(path, { ok: "Stripe n'était pas connecté." });
  const force = fd?.get("force") === "on";
  const blocked = disconnectBlockMessage(await stripeDisconnectBlockers(storeId));
  if (blocked && !force) back(path, { error: blocked });
  const shared = await db.store.count({ where: { stripeAccountId: store.stripeAccountId, id: { not: storeId } } });
  // The store lets go of the account first: the account.application.deauthorized webhook that the
  // revocation below triggers then finds a past account (marked revoked, quiet), never the current
  // connection (which would journal a false « Stripe a retiré l'accès » alert).
  const forgotten = await forgetStripeAccount(store, {
    by: "merchant",
    message: `Compte Stripe « ${store.stripeAccountName ?? store.stripeAccountId} » déconnecté depuis le dashboard${blocked ? ` malgré l'avertissement (${blocked.replace(/^Déconnexion refusée : /, "").split(".")[0]})` : ""}.`,
    revoked: false,
  });
  let revokeFailed = false;
  // Not forgotten here (a reconnection or another disconnect raced this one): its access is left alone.
  if (forgotten && !shared) {
    try {
      await deauthorizeStripe(store.stripeAccountId, stripeConnectionMode(store));
      await markPastStripeAccountRevoked(storeId, store.stripeAccountId);
    } catch (err) {
      revokeFailed = true;
      log.warn("stripe.deauthorize_failed", "Stripe deauthorization failed (the store forgot the account anyway)", { storeId, err });
    }
  }
  revalidatePath(storePath(storeId), "layout");
  back(path, {
    ok: revokeFailed
      ? "Stripe déconnecté de cette boutique. Stripe n'a pas confirmé le retrait de l'accès : retirez l'app dans Stripe → Paramètres → Applications connectées si elle y figure encore."
      : "Stripe déconnecté.",
  });
}

const PAYMENT_MODES = ["whop_primary", "stripe_primary", "stripe_only"] as const;

/** Which processor goes first: « Whop principal » (default), « Stripe principal » or « Stripe uniquement ». */
export async function savePaymentModeAction(storeId: string, fd: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "stripe");
  const mode = str(fd, "paymentMode");
  if (!(PAYMENT_MODES as readonly string[]).includes(mode)) back(path, { error: "Mode de paiement inconnu", field: "paymentMode" });
  const next = mode as (typeof PAYMENT_MODES)[number];
  const problem = paymentModeProblem(store, next);
  if (problem) back(path, { error: problem, field: "paymentMode" });
  if (next === store.paymentMode) back(path, { ok: "Mode de paiement inchangé" });
  // A failover belongs to the previous order of the processors: the new one starts clean.
  await db.store.update({ where: { id: storeId }, data: { paymentMode: next, providerFailoverAt: null, providerFailoverReason: null } });
  const label = PAYMENT_MODE_LABELS[next];
  await recordEvent({ storeId, kind: "payment_mode.changed", message: `Mode de paiement : « ${label} ».`, data: { from: store.paymentMode, to: next } });
  revalidatePath(storePath(storeId), "layout");
  back(path, { ok: `Mode de paiement enregistré : ${label}.` });
}

/** Registers (again) the checkout hosts on the connected Stripe account for Apple Pay / Google Pay. */
export async function registerStripeDomainsAction(storeId: string) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "stripe");
  if (!store.stripeAccountId) back(path, { error: "Connectez Stripe d'abord" });
  // Registered with the keys of the store's mode: only when the connection covers that mode.
  if (!stripeConfigured(stripeModeOf(store)) || (!store.testMode && store.stripeLivemode !== true)) {
    back(path, { error: stripeUnusableReason(store) ?? "Stripe n'est pas utilisable dans le mode actuel de la boutique." });
  }
  const { hosts, failed, pending } = await registerWalletDomains(store);
  // While Stripe is being worked on: its Connect webhook too (journaled when it can't be set up).
  const webhook = await ensureStripeWebhook(storeId, stripeModeOf(store), { lazy: true });
  const webhookError = webhook ? `Webhook Stripe à réparer (« Réparer la liaison Stripe ») : ${webhook}.` : undefined;
  if (!hosts.length) {
    back(path, {
      error: `Aucun domaine à enregistrer : le checkout est servi sur une adresse locale. Configurez un domaine du checkout vérifié (Réglages) ou une APP_URL publique, puis réessayez.${webhookError ? ` ${webhookError}` : ""}`,
    });
  }
  if (failed.length) back(path, { error: `Stripe n'a pas pu enregistrer : ${failed.join(", ")}.${webhookError ? ` ${webhookError}` : ""}` });
  if (pending.length) back(path, { error: `Domaine(s) enregistré(s) chez Stripe, Apple Pay pas encore actif : ${pending.join(", ")}. Réessayez dans quelques minutes.${webhookError ? ` ${webhookError}` : ""}` });
  // Domains fine: that success is said as such, the webhook problem apart.
  back(path, { ok: `Apple Pay actif chez Stripe sur ${hosts.join(", ")}.`, error: webhookError });
}

/** Registers the store's wallet hosts (stripeWalletHosts) on its connected account: those Stripe refused, those not active yet. */
async function registerWalletDomains(store: Parameters<typeof stripeWalletHosts>[0] & Parameters<typeof registerStripeDomain>[0]): Promise<{ hosts: string[]; failed: string[]; pending: string[] }> {
  const hosts = stripeWalletHosts(store);
  const failed: string[] = [];
  const pending: string[] = [];
  for (const host of hosts) {
    try {
      if ((await registerStripeDomain(store, host)) !== "active") pending.push(host);
    } catch (err) {
      log.warn("stripe.domain_failed", "Could not register a payment method domain on Stripe", { storeId: store.id, host, err });
      failed.push(`${host} (${errorMessage(err)})`);
    }
  }
  return { hosts, failed, pending };
}

/** « Réparer la liaison Stripe »: (re)creates or checks the platform's Connect webhook of the store's mode. */
export async function repairStripeWebhookAction(storeId: string) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "stripe");
  if (!store.stripeAccountId) back(path, { error: "Connectez Stripe d'abord" });
  const error = await ensureStripeWebhook(storeId, stripeModeOf(store));
  if (error) back(path, { error: `Liaison Stripe non réparée : ${error}` });
  await recordEvent({ storeId, kind: "stripe.webhook_repaired", message: "Liaison Stripe (webhook) vérifiée depuis le tableau de bord." });
  revalidatePath(storePath(storeId), "layout");
  back(path, { ok: "Liaison Stripe vérifiée : le webhook est en place." });
}

/** Saves Apple's domain-association file (from Whop) and registers the checkout domain. */
export async function setupApplePayAction(storeId: string, fd: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "whop");
  const file = String(fd.get("association") ?? "").trim();
  if (file) {
    if (file.length > 20000) back(path, { error: "Fichier Apple Pay trop volumineux : collez uniquement son contenu", field: "association" });
    await db.appSetting.upsert({
      where: { key: APPLE_PAY_ASSOCIATION_KEY },
      update: { value: file },
      create: { key: APPLE_PAY_ASSOCIATION_KEY, value: file },
    });
    // The file serves every host: the other stores' verified checkout domains can now be registered.
    const others = await db.store.findMany({
      where: { id: { not: storeId }, checkoutDomain: { not: null }, checkoutDomainVerifiedAt: { not: null }, whopConnectedAt: { not: null } },
      select: { id: true },
      take: 20,
    });
    await Promise.all(others.map((o) => reregisterApplePayDomain(o.id)));
  }
  // The store's verified checkout domain (checkout.seyuna.com) is where buyers pay; APP_URL's host
  // stays registered too (links sent before the domain, fallback while it is down).
  const hosts = [...new Set([checkoutHostOf(store), new URL(env.appUrl).hostname])];
  let status = "pending";
  try {
    for (const host of hosts) {
      const domain = await registerApplePayDomain(store, host);
      if (host === hosts[0]) status = domain.status;
    }
  } catch (err) {
    back(path, { error: `Whop n'a pas pu enregistrer le domaine : ${errorMessage(err)}` });
  }
  if (status === "verified") back(path, { ok: `Apple Pay est activé sur votre checkout (${hosts[0]})` });
  back(path, {
    error: "Domaine enregistré mais pas encore vérifié par Apple. Vérifiez le fichier collé, puis réessayez dans quelques minutes.",
  });
}

/* ------------------------------------------------------------------ */
/* Checkout domain                                                     */
/* ------------------------------------------------------------------ */

/**
 * "Domaine du checkout": saves the hostname (validated, unique), adds it to the Vercel project when
 * the Vercel API is configured, then checks it right away (already verified when the DNS was ready).
 */
export async function saveCheckoutDomainAction(storeId: string, fd: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "settings");
  const checked = normalizeCheckoutDomain(str(fd, "checkoutDomain"), {
    storefrontHosts: [store.storefrontHost, store.shopDomain],
    // The root of the merchant's domain needs the card's explicit confirmation (its site would move).
    confirmApex: fd.get("confirmApex") === "on",
  });
  if (!checked.ok) back(path, { error: checked.error, field: "checkoutDomain" });
  const domain = checked.domain;
  if (domain === store.checkoutDomain) {
    if (!domain) back(path, { ok: "Aucun domaine du checkout" });
    // Saved again while not working (the messages ask for it): retry the Vercel step, then check.
    const cfgAgain = vercelConfig();
    const lastError = parseDomainError(store.checkoutDomainError);
    if ((store.checkoutDomainVerifiedAt && !lastError) || (!cfgAgain && lastError?.kind !== "vercel")) back(path, { ok: "Domaine du checkout inchangé" });
    if (!(await rateLimit(`checkout-domain:verify:${storeId}`, 12))) back(path, { error: "Trop de vérifications d'affilée : réessayez dans une minute." });
    const again = cfgAgain ? await addDomainToVercel(cfgAgain, domain) : null;
    if (again) {
      await db.store.updateMany({ where: { id: storeId, checkoutDomain: domain, checkoutDomainVerifiedAt: null }, data: { checkoutDomainError: formatDomainError("vercel", again), checkoutDomainCheckedAt: new Date() } });
      revalidatePath(storePath(storeId), "layout");
      back(path, { error: again, field: "checkoutDomain" });
    }
    const recheck = await checkStoreDomain(storeId, { vercel: !!cfgAgain });
    revalidatePath(storePath(storeId), "layout");
    if (recheck.verified && !recheck.message) back(path, { ok: `Domaine vérifié : vos clients paient désormais sur ${domain}` });
    back(path, { error: recheck.message ?? "Le domaine ne répond pas encore." });
  }
  const other = domain ? await db.store.findFirst({ where: { checkoutDomain: domain, NOT: { id: storeId } }, select: { name: true } }) : null;
  if (other) back(path, { error: `${domain} est déjà le domaine du checkout de la boutique « ${other.name} ».`, field: "checkoutDomain" });
  // Retired by another store less than 48 h ago: its open checkouts and payment return links still
  // use it (they must keep reaching that store), so it can't be taken over before then.
  const retiredBy = domain ? await retiredDomainOwner(domain) : null;
  if (retiredBy && retiredBy !== storeId) {
    back(path, {
      error: `${domain} vient d'être retiré par une autre boutique : ses liens de paiement déjà envoyés l'utilisent encore pendant 48 h. Réessayez après ce délai, ou choisissez un autre domaine.`,
      field: "checkoutDomain",
    });
  }
  const cfg = vercelConfig();
  const vercelError = domain && cfg ? await addDomainToVercel(cfg, domain) : null;
  try {
    await db.store.update({
      where: { id: storeId },
      data: {
        checkoutDomain: domain,
        checkoutDomainVerifiedAt: null,
        checkoutDomainCheckedAt: null,
        checkoutDomainPendingSince: domain ? new Date() : null,
        checkoutDomainError: vercelError ? formatDomainError("vercel", vercelError) : null,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") back(path, { error: `${domain} est déjà utilisé par une autre boutique.`, field: "checkoutDomain" });
    throw err;
  }
  // The old domain stays on the Vercel project for 48 h (open checkouts, Whop's return URLs sent
  // with it keep working: its /c pages send buyers to the new host), then the tick removes it.
  if (domain) await unretireCheckoutDomain(domain);
  if (store.checkoutDomain) await retireCheckoutDomain(storeId, store.checkoutDomain);
  await recordEvent({
    storeId,
    kind: "checkout_domain.saved",
    message: domain ? `Domaine du checkout enregistré : ${domain}.` : `Domaine du checkout retiré${store.checkoutDomain ? ` (${store.checkoutDomain})` : ""} : le checkout est de nouveau servi sur ${new URL(env.appUrl).hostname}.`,
  });
  revalidatePath(storePath(storeId), "layout");
  if (!domain) back(path, { ok: "Domaine du checkout retiré" });
  if (vercelError) back(path, { error: vercelError, field: "checkoutDomain" });
  const result = await checkStoreDomain(storeId, { vercel: !!cfg });
  if (result.verified) back(path, { ok: `Domaine vérifié : vos clients paient désormais sur ${domain}` });
  back(path, { ok: `Domaine enregistré. Ajoutez l'enregistrement DNS indiqué, puis cliquez sur « Vérifier ».` });
}

/** Adds the domain to the Vercel project; the merchant's message when Vercel refuses, else null. */
async function addDomainToVercel(cfg: VercelConfig, domain: string): Promise<string | null> {
  try {
    await addProjectDomain(cfg, domain);
    return null;
  } catch (err) {
    return err instanceof VercelApiError && err.status === 409
      ? `Vercel refuse ${domain} : il est déjà utilisé par un autre projet ou compte Vercel. Retirez-le de là-bas, puis enregistrez de nouveau.`
      : `Vercel n'a pas pu ajouter ${domain} au projet (${errorMessage(err)}). Ajoutez-le dans Vercel → Settings → Domains.`;
  }
}

/** "Vérifier": pings https://<domain>/.well-known/whop-checkout-ping now (5 s at most). */
export async function verifyCheckoutDomainAction(storeId: string) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "settings");
  if (!store.checkoutDomain) back(path, { error: "Enregistrez d'abord un domaine du checkout." });
  if (!(await rateLimit(`checkout-domain:verify:${storeId}`, 12))) back(path, { error: "Trop de vérifications d'affilée : réessayez dans une minute." });
  // Missing from the Vercel project (never added, removed by hand): added back before the check.
  const cfg = vercelConfig();
  if (cfg && !(store.checkoutDomainVerifiedAt && !store.checkoutDomainError)) {
    const missing = await getProjectDomain(cfg, store.checkoutDomain).then(
      () => false,
      (err) => err instanceof VercelApiError && err.status === 404,
    );
    const refused = missing ? await addDomainToVercel(cfg, store.checkoutDomain) : null;
    if (refused) back(path, { error: refused });
  }
  const result = await checkStoreDomain(storeId);
  revalidatePath(storePath(storeId), "layout");
  // verified with a message: a first failed check, the domain stays in use until the next one fails.
  if (result.verified && !result.message) back(path, { ok: `Domaine vérifié : vos clients paient désormais sur ${result.domain}` });
  back(path, { error: result.message ?? "Le domaine ne répond pas encore." });
}

/* ------------------------------------------------------------------ */
/* Interception                                                        */
/* ------------------------------------------------------------------ */

export async function saveInterceptionAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const parsed = interceptionSchema.safeParse({
    cartCheckout: fd.get("cartCheckout") === "on",
    cartDrawer: fd.get("cartDrawer") === "on",
    buyNow: fd.get("buyNow") === "on",
    addToCartDirect: fd.get("addToCartDirect") === "on",
    customSelectors: str(fd, "customSelectors"),
    excludedHandles: str(fd, "excludedHandles")
      .split(/[\n,]/)
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  });
  if (!parsed.success) back(storePath(storeId, "interception"), { error: parsed.error.issues[0]?.message && issueField(parsed.error.issues) === "customSelectors" ? `Sélecteurs personnalisés : ${parsed.error.issues[0].message}` : "Réglages invalides", field: issueField(parsed.error.issues) });
  await db.store.update({ where: { id: storeId }, data: { interception: parsed.data } });
  back(storePath(storeId, "interception"), { ok: "Interception mise à jour — actif sur la boutique en quelques secondes." });
}

/* ------------------------------------------------------------------ */
/* Builder                                                             */
/* ------------------------------------------------------------------ */

export async function saveBuilderAction(
  storeId: string,
  page: "checkout" | "thank-you",
  theme: Theme,
  layout: Layout,
  /** The other page's layout, when the builder changed it too (a template applied with its matching page). */
  otherLayout?: Layout,
): Promise<{ ok: true; draft: boolean } | { ok: false; error: string }> {
  const store = await getStore(storeId);
  const t = themeSchema.safeParse(theme);
  if (!t.success) return { ok: false, error: `Thème invalide : ${t.error.issues[0]?.path.join(".")} ${t.error.issues[0]?.message}` };
  const l = (page === "checkout" ? checkoutLayoutSchema : thankYouLayoutSchema).safeParse(layout);
  if (!l.success) return { ok: false, error: l.error.issues[0]?.message ?? "Mise en page invalide" };
  const o = otherLayout === undefined ? null : (page === "checkout" ? thankYouLayoutSchema : checkoutLayoutSchema).safeParse(otherLayout);
  if (o && !o.success) return { ok: false, error: o.error.issues[0]?.message ?? "Mise en page invalide" };
  const [checkoutData, thankYouData] = page === "checkout" ? [l.data, o?.data] : [o?.data, l.data];
  const layouts = {
    ...(checkoutData ? { draftCheckoutLayout: checkoutData as Prisma.InputJsonValue } : {}),
    ...(thankYouData ? { draftThankYouLayout: thankYouData as Prisma.InputJsonValue } : {}),
  };
  // Edits undone back to the published design (both pages, normalised the same way):
  // there is no draft any more, so "Publier" has nothing to do.
  const next = {
    ...store,
    draftTheme: t.data as Prisma.JsonValue,
    ...(layouts as { draftCheckoutLayout?: Prisma.JsonValue; draftThankYouLayout?: Prisma.JsonValue }),
  };
  if (hasPublished(store) && sameDesign(draftDesign(next), publishedDesign(store))) {
    await db.store.update({
      where: { id: storeId },
      data: { draftTheme: Prisma.DbNull, draftCheckoutLayout: Prisma.DbNull, draftThankYouLayout: Prisma.DbNull, draftUpdatedAt: null },
    });
    return { ok: true, draft: false };
  }
  // Autosave goes to the draft: buyers keep seeing the published design until "Publier".
  await db.store.update({
    where: { id: storeId },
    data: {
      draftTheme: t.data as Prisma.InputJsonValue,
      ...layouts,
      draftUpdatedAt: new Date(),
    },
  });
  return { ok: true, draft: true };
}

/** Publishes the drafts (theme + both layouts) and keeps a version in the history. */
export async function publishDesignAction(
  storeId: string,
  label: string,
): Promise<{ ok: true; /** Deleted images emptied on the way: the builder reloads the published design. */ stripped: number } | { ok: false; error: string }> {
  const store = await getStore(storeId);
  const design = draftDesign(store);
  const t = themeSchema.safeParse(design.theme);
  const c = checkoutLayoutSchema.safeParse(design.checkoutLayout);
  const y = thankYouLayoutSchema.safeParse(design.thankYouLayout);
  if (!t.success || !c.success || !y.success) return { ok: false, error: "Le brouillon contient une erreur : corrigez-la avant de publier." };
  const published = await db.$transaction(async (tx) => {
    // Under the Store row lock image deletes take: the draft read again, and any image deleted
    // meanwhile (brought back by undo, a restored version or a racing delete) emptied, never published.
    await lockStore(tx, storeId);
    const draft = draftDesign(await tx.store.findUniqueOrThrow({ where: { id: storeId } }));
    const missing = await missingMediaIds(tx, storeId, draft);
    const fresh = await withoutMissingMedia(tx, storeId, draft);
    const t = themeSchema.safeParse(fresh.theme);
    const c = checkoutLayoutSchema.safeParse(fresh.checkoutLayout);
    const y = thankYouLayoutSchema.safeParse(fresh.thankYouLayout);
    if (!t.success || !c.success || !y.success) return false;
    // Sample reviews / figures / coupon / testimonial need no gate: the live page never shows them
    // (isEmptyInLive → isSampleOnly, liveReviewItems), whatever gets published.
    await tx.store.update({
      where: { id: storeId },
      data: {
        theme: t.data as Prisma.InputJsonValue,
        checkoutLayout: c.data as Prisma.InputJsonValue,
        thankYouLayout: y.data as Prisma.InputJsonValue,
        draftTheme: Prisma.DbNull,
        draftCheckoutLayout: Prisma.DbNull,
        draftThankYouLayout: Prisma.DbNull,
        draftUpdatedAt: null,
        publishedAt: new Date(),
      },
    });
    await tx.layoutVersion.create({
      data: {
        storeId,
        label: label.trim().slice(0, 80) || `Publication du ${new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: tzOf(store) })}`,
        theme: t.data as Prisma.InputJsonValue,
        checkoutLayout: c.data as Prisma.InputJsonValue,
        thankYouLayout: y.data as Prisma.InputJsonValue,
      },
    });
    return { stripped: missing.length };
  });
  if (!published) return { ok: false, error: "Le brouillon contient une erreur : corrigez-la avant de publier." };
  await recordEvent({ storeId, kind: "design.published", message: "Nouveau design publié sur le checkout" });
  revalidatePath(storePath(storeId), "layout");
  return { ok: true, stripped: published.stripped };
}

/** Loads a version from the history into the draft (publish to make it live). */
export async function restoreVersionAction(storeId: string, versionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await getStore(storeId);
  const v = await db.layoutVersion.findFirst({ where: { id: versionId, storeId } });
  if (!v) return { ok: false, error: "Version introuvable" };
  await db.store.update({
    where: { id: storeId },
    data: {
      draftTheme: v.theme as Prisma.InputJsonValue,
      draftCheckoutLayout: v.checkoutLayout as Prisma.InputJsonValue,
      draftThankYouLayout: v.thankYouLayout as Prisma.InputJsonValue,
      draftUpdatedAt: new Date(),
    },
  });
  return { ok: true };
}

/** Throws the draft away and goes back to the published design. */
export async function discardDraftAction(storeId: string): Promise<{ ok: true }> {
  await getStore(storeId);
  await db.store.update({
    where: { id: storeId },
    data: { draftTheme: Prisma.DbNull, draftCheckoutLayout: Prisma.DbNull, draftThankYouLayout: Prisma.DbNull, draftUpdatedAt: null },
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* A/B tests                                                           */
/* ------------------------------------------------------------------ */

export async function startExperimentAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const path = storePath(storeId, "analytics?tab=tests");
  const versionId = str(fd, "versionId");
  const version = await db.layoutVersion.findFirst({ where: { id: versionId, storeId } });
  if (!version) back(path, { error: "Choisissez la version à tester (variante B).", field: "versionId" });
  // Refused rather than clamped: the test must run with the share that was chosen.
  const splitRaw = str(fd, "split") || "50";
  const split = /^\d{1,2}$/.test(splitRaw) ? Number(splitRaw) : NaN;
  if (!(split >= 10 && split <= 90)) back(path, { error: "Part de trafic B : nombre entier entre 10 et 90 %", field: "split" });
  // Under the Store row lock image deletes take: once the test runs, both its versions count as live
  // (mediaUsage) and their images can't be deleted; an image deleted before is caught here, so a
  // test never serves a broken image.
  const started = await db.$transaction(async (tx) => {
    await lockStore(tx, storeId);
    if ((await missingMediaIds(tx, storeId, [version.theme, version.checkoutLayout, version.thankYouLayout])).length > 0) return false;
    const store = await tx.store.findUniqueOrThrow({ where: { id: storeId } });
    const published = await withoutMissingMedia(tx, storeId, {
      theme: store.theme ?? {},
      checkoutLayout: store.checkoutLayout ?? { blocks: [] },
      thankYouLayout: store.thankYouLayout ?? { blocks: [] },
    });
    // Pin the control: publishing during the test must not change variant A.
    const control = await tx.layoutVersion.create({
      data: {
        storeId,
        label: `Contrôle A — ${new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: tzOf(store) })}`,
        theme: published.theme as Prisma.InputJsonValue,
        checkoutLayout: published.checkoutLayout as Prisma.InputJsonValue,
        thankYouLayout: published.thankYouLayout as Prisma.InputJsonValue,
      },
    });
    await tx.experiment.updateMany({ where: { storeId, status: "RUNNING" }, data: { status: "STOPPED", endedAt: new Date() } });
    await tx.experiment.create({
      data: { storeId, versionId, versionIdA: control.id, splitB: split, autoPromote: fd.get("autoPromote") === "on", name: str(fd, "name").slice(0, 80) || `Test « ${version.label} »` },
    });
    return true;
  });
  if (!started)
    back(path, {
      error: `« ${version.label} » affiche une image supprimée de « Mes images » : restaurez cette version dans l'éditeur, remplacez l'image, publiez, puis testez la nouvelle version.`,
      field: "versionId",
    });
  await recordEvent({ storeId, kind: "experiment.started", message: `Test A/B lancé : ${version.label} sur ${split} % du trafic` });
  back(path, { ok: `Test A/B lancé : ${split} % des nouveaux checkouts voient « ${version.label} ».` });
}

export async function stopExperimentAction(storeId: string, experimentId: string, promote: boolean) {
  await getStore(storeId);
  const path = storePath(storeId, "analytics?tab=tests");
  const exp = await db.experiment.findFirst({ where: { id: experimentId, storeId } });
  if (!exp) back(path, { error: "Test introuvable" });
  // Under the Store row lock image deletes take, and with any image deleted meanwhile emptied: the
  // promoted variant never shows a broken image.
  await db.$transaction(async (tx) => {
    await lockStore(tx, storeId);
    await tx.experiment.update({ where: { id: exp.id }, data: { status: "STOPPED", endedAt: new Date() } });
    if (!promote) return;
    const v = await tx.layoutVersion.findUnique({ where: { id: exp.versionId } });
    if (!v) return;
    const d = await withoutMissingMedia(tx, storeId, { theme: v.theme, checkoutLayout: v.checkoutLayout, thankYouLayout: v.thankYouLayout });
    await tx.store.update({
      where: { id: storeId },
      data: {
        theme: d.theme as Prisma.InputJsonValue,
        checkoutLayout: d.checkoutLayout as Prisma.InputJsonValue,
        thankYouLayout: d.thankYouLayout as Prisma.InputJsonValue,
        publishedAt: new Date(),
      },
    });
  });
  await recordEvent({ storeId, kind: "experiment.stopped", message: promote ? "Test A/B terminé : variante B publiée" : "Test A/B arrêté" });
  back(path, { ok: promote ? "Variante B publiée pour tous les clients." : "Test arrêté : tout le monde voit le design publié." });
}

/* ------------------------------------------------------------------ */
/* Shipping                                                            */
/* ------------------------------------------------------------------ */

/** "FR, BE de" → ["FR","BE","DE"]; null when a token isn't a 2-letter ISO code. */
const countriesField = (v: string): string[] | null => {
  const tokens = v
    .split(/[\s,;]+/)
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  if (tokens.some((c) => !/^[A-Z]{2}$/.test(c))) return null;
  return [...new Set(tokens)];
};

export async function saveRateAction(storeId: string, fd: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "shipping");
  const id = str(fd, "id");
  const name = str(fd, "name").slice(0, 80);
  const price = cents(str(fd, "price"));
  if (!name) back(path, { error: "Nom du tarif obligatoire", field: "name" });
  if (price == null) back(path, { error: "Prix invalide (ex. 4,90 ; 2 décimales, max 1 000 000)", field: "price" });
  const countries = countriesField(str(fd, "countries"));
  if (!countries) back(path, { error: "Pays : utilisez les codes à 2 lettres séparés par des virgules (ex. FR, BE, CH)", field: "countries" });
  const freeOverRaw = str(fd, "freeOver");
  const freeOver = cents(freeOverRaw);
  if (freeOverRaw && freeOver == null) back(path, { error: "Seuil de livraison gratuite invalide (ex. 50 ou 49,90)", field: "freeOver" });
  const costRaw = str(fd, "cost");
  const cost = cents(costRaw);
  if (costRaw && cost == null) back(path, { error: "Coût réel invalide (ex. 4,90)", field: "cost" });
  // Older forms have no "kind" field: keep home delivery.
  const kind = str(fd, "kind") === "pickup" ? "pickup" : "home";
  if (kind === "pickup" && !pickupConfigured(store)) {
    back(path, { error: "Point relais : configurez d'abord Mondial Relay en haut de cette page (code enseigne + clé privée).", field: "kind" });
  }
  const i18n = fd.has("i18n") ? (cleanRecordI18n(fd.get("i18n"), ["name", "deliveryTime"]) ?? Prisma.DbNull) : undefined;
  const data = {
    ...(i18n !== undefined ? { i18n } : {}),
    name,
    deliveryTime: str(fd, "deliveryTime").slice(0, 80) || null,
    countries,
    priceCents: price,
    freeOverCents: freeOver,
    costCents: cost,
    kind,
    active: fd.get("active") === "on",
  };
  if (id) await db.shippingRate.update({ where: { id, storeId }, data });
  else {
    const count = await db.shippingRate.count({ where: { storeId } });
    await db.shippingRate.create({ data: { ...data, storeId, position: count } });
  }
  back(path, { ok: "Tarif enregistré" });
}

export async function deleteRateAction(storeId: string, id: string) {
  await getStore(storeId);
  await db.shippingRate.delete({ where: { id, storeId } });
  back(storePath(storeId, "shipping"), { ok: "Tarif supprimé" });
}

/* ------------------------------------------------------------------ */
/* Discounts & add-ons                                                 */
/* ------------------------------------------------------------------ */

const discountForm = z.object({
  code: z
    .string()
    .trim()
    .min(2, "Le code doit faire au moins 2 caractères")
    .max(40, "Le code doit faire au plus 40 caractères")
    .regex(/^[A-Za-z0-9_-]+$/, "Lettres, chiffres, - et _ uniquement")
    .transform((c) => c.toUpperCase()),
  type: z.enum(["PERCENT", "FIXED", "FREE_SHIPPING"]),
  value: z.string(),
  minSubtotal: z.string(),
  endsAt: z.string(),
  startsAt: z.string().optional().default(""),
  usageLimit: z.string(),
});

/** Validates the discount form (create and edit share it); redirects back with the first error. */
function parseDiscount(fd: FormData, path: string, tz: string) {
  const parsed = discountForm.safeParse(Object.fromEntries(fd));
  if (!parsed.success) back(path, { error: parsed.error.issues[0]?.message ?? "Code invalide", field: issueField(parsed.error.issues) });
  const f = parsed.data;
  let value = 0;
  if (f.type === "PERCENT") {
    // "12,5" is refused, not rounded to 13: the checkout would apply a different discount than typed.
    const raw = f.value.replace(/\s|%/g, "");
    value = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
    if (!(value >= 1 && value <= 100)) back(path, { error: "Pourcentage entier entre 1 et 100", field: "value" });
  } else if (f.type === "FIXED") {
    value = cents(f.value) ?? 0;
    if (value <= 0) back(path, { error: "Montant de réduction invalide (ex. 5 ou 4,90)", field: "value" });
  }
  if (f.minSubtotal && cents(f.minSubtotal) == null) back(path, { error: "Minimum de commande invalide (ex. 40 ou 39,90)", field: "minSubtotal" });
  // "10,5" or "12abc" is refused (parseInt would quietly keep 10 / 12).
  const usageLimit = f.usageLimit ? (/^\d+$/.test(f.usageLimit.replace(/\s/g, "")) ? Number(f.usageLimit.replace(/\s/g, "")) : NaN) : null;
  if (usageLimit != null && !(usageLimit >= 1 && usageLimit <= 1_000_000)) {
    back(path, { error: "Limite d'utilisation : nombre entier entre 1 et 1 000 000", field: "usageLimit" });
  }
  // "Expire le 31/12" means usable all day on the 31st (the store's time zone, Paris by default).
  const endsAt = f.endsAt ? endOfDayIn(frenchDateToIso(f.endsAt), tz) : null;
  if (f.endsAt && !endsAt) back(path, { error: "Date d'expiration invalide : utilisez le format jj/mm/aaaa", field: "endsAt" });
  // "Valable dès le 01/12" means from midnight in the store's time zone.
  const startsAt = f.startsAt ? startOfDayIn(frenchDateToIso(f.startsAt), tz) : null;
  if (f.startsAt && !startsAt) back(path, { error: "Date de début invalide : utilisez le format jj/mm/aaaa", field: "startsAt" });
  if (startsAt && endsAt && startsAt > endsAt) back(path, { error: "La date de début doit précéder la date d'expiration", field: "startsAt" });
  // "Cumulable avec les remises quantité" (unchecked: the code or the quantity break, whichever saves more).
  const combinesWithBreaks = fd.get("combinesWithBreaks") === "on";
  return { code: f.code, type: f.type, value, minSubtotalCents: cents(f.minSubtotal), startsAt, endsAt, usageLimit, combinesWithBreaks };
}

/** "31/12/2026" (or already "2026-12-31") → "2026-12-31"; anything else is returned as is (and rejected later). */
function frenchDateToIso(v: string): string {
  const m = v.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!m) return v.trim();
  const [, d, mo, y] = m;
  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  // Reject impossible dates (31/02) instead of letting Date roll them over.
  const check = new Date(`${iso}T12:00:00Z`);
  return !Number.isNaN(check.getTime()) && check.toISOString().slice(0, 10) === iso ? iso : "invalid";
}

export async function createDiscountAction(storeId: string, fd: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "offers");
  const data = parseDiscount(fd, path, tzOf(store));
  const exists = await db.discountCode.findUnique({ where: { storeId_code: { storeId, code: data.code } } });
  if (exists) back(path, { error: `Le code ${data.code} existe déjà` });
  try {
    await db.discountCode.create({ data: { storeId, ...data } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      back(path, { error: `Le code ${data.code} existe déjà` });
    }
    throw err;
  }
  back(path, { ok: `Code ${data.code} créé` });
}

export async function updateDiscountAction(storeId: string, id: string, fd: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "offers");
  const current = await db.discountCode.findFirst({ where: { id, storeId } });
  if (!current) back(path, { error: "Code introuvable" });
  const data = parseDiscount(fd, path, tzOf(store));
  if (data.code !== current.code) {
    const clash = await db.discountCode.findUnique({ where: { storeId_code: { storeId, code: data.code } } });
    if (clash) back(path, { error: `Le code ${data.code} existe déjà` });
  }
  try {
    await db.discountCode.update({ where: { id, storeId }, data });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      back(path, { error: `Le code ${data.code} existe déjà` });
    }
    throw err;
  }
  back(path, { ok: `Code ${data.code} mis à jour` });
}

export async function toggleDiscountAction(storeId: string, id: string) {
  await getStore(storeId);
  const d = await db.discountCode.findUniqueOrThrow({ where: { id, storeId } });
  await db.discountCode.update({ where: { id }, data: { active: !d.active } });
  back(storePath(storeId, "offers"));
}

export async function deleteDiscountAction(storeId: string, id: string) {
  await getStore(storeId);
  await db.discountCode.delete({ where: { id, storeId } });
  back(storePath(storeId, "offers"), { ok: "Code supprimé" });
}

const addOnForm = z.object({
  title: z.string().trim().min(1, "Titre obligatoire").max(80, "Titre : 80 caractères maximum"),
  description: z.string().trim().max(200, "Description : 200 caractères maximum"),
  price: z.string().trim().min(1, "Prix obligatoire"),
  variantId: z.string().trim(),
  imageUrl: z.string().trim().refine((v) => !v || /^https?:\/\/\S+$/i.test(v), "Image : collez une adresse commençant par https://"),
});

const ruleProduct = z.object({ id: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/), title: z.string().trim().max(200) });

/** « Conditions d'affichage » → AddOn.showIf (the shape addOnEligible reads), or null when always shown. */
function parseShowIf(fd: FormData, path: string): Prisma.InputJsonValue | null {
  const minRaw = str(fd, "ruleMinSubtotal");
  const maxRaw = str(fd, "ruleMaxSubtotal");
  const min = cents(minRaw);
  const max = cents(maxRaw);
  if (minRaw && min == null) back(path, { error: "Condition : panier minimum invalide (ex. 40)", field: "ruleMinSubtotal" });
  if (maxRaw && max == null) back(path, { error: "Condition : panier maximum invalide (ex. 150)", field: "ruleMaxSubtotal" });
  if (min != null && max != null && min > max) back(path, { error: "Condition : le panier minimum dépasse le panier maximum", field: "ruleMinSubtotal" });
  const products: { id: string; title: string }[] = [];
  for (const raw of fd.getAll("ruleProducts")) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      /* rejected below */
    }
    const p = ruleProduct.safeParse(parsed);
    if (!p.success) back(path, { error: "Condition : produit Shopify invalide" });
    if (!products.some((x) => x.id === p.data.id)) products.push(p.data);
  }
  if (products.length > 20) back(path, { error: "Condition : 20 produits maximum" });
  const countries = [...new Set(fd.getAll("ruleCountries").map((c) => String(c).trim().toUpperCase()))];
  if (countries.some((c) => !/^[A-Z]{2}$/.test(c))) back(path, { error: "Condition : code pays invalide" });
  const rules: Record<string, Prisma.InputJsonValue> = {};
  if (min != null) rules.minSubtotalCents = min;
  if (max != null) rules.maxSubtotalCents = max;
  if (products.length) {
    rules.productIds = products.map((p) => p.id);
    rules.productTitles = Object.fromEntries(products.map((p) => [p.id, p.title]));
  }
  if (countries.length) rules.countries = countries;
  return Object.keys(rules).length ? rules : null;
}

/** Validates the add-on form (create and edit share it); redirects back with the first error. */
function parseAddOn(fd: FormData, path: string) {
  const parsed = addOnForm.safeParse({
    title: str(fd, "title"),
    description: str(fd, "description"),
    price: str(fd, "price"),
    variantId: str(fd, "variantId"),
    imageUrl: str(fd, "imageUrl"),
  });
  if (!parsed.success) back(path, { error: parsed.error.issues[0]?.message ?? "Option invalide", field: issueField(parsed.error.issues) });
  const f = parsed.data;
  const price = cents(f.price);
  if (price == null || price <= 0) back(path, { error: "Prix invalide (ex. 2,99)", field: "price" });
  const variant = f.variantId;
  // Accepts a bare id, a gid, or a Shopify admin URL (…/variants/456): the last number wins.
  const variantNum = variant.startsWith("gid://") ? null : variant.match(/(\d+)\D*$/)?.[1];
  if (variant && !variant.startsWith("gid://shopify/ProductVariant/") && !variantNum) {
    back(path, { error: "ID de variante invalide : collez le numéro de la variante Shopify", field: "variantId" });
  }
  const costRaw = str(fd, "cost");
  const cost = cents(costRaw);
  if (costRaw && cost == null) back(path, { error: "Coût du produit invalide (ex. 3,20)", field: "cost" });
  // Forms without the rules disclosure (none today) must not wipe saved rules.
  const showIf = fd.has("ruleMinSubtotal") ? parseShowIf(fd, path) : undefined;
  // Buyer-language title / description (Shopify lines keep the base title).
  const i18n = fd.has("i18n") ? (cleanRecordI18n(fd.get("i18n"), ["title", "description"]) ?? Prisma.DbNull) : undefined;
  return {
    costCents: cost,
    ...(i18n !== undefined ? { i18n } : {}),
    ...(showIf !== undefined ? { showIf: showIf ?? Prisma.DbNull } : {}),
    title: f.title,
    description: f.description || null,
    priceCents: price,
    variantId: variant ? (variant.startsWith("gid://") ? variant : `gid://shopify/ProductVariant/${variantNum}`) : null,
    imageUrl: f.imageUrl || null,
  };
}

export async function createAddOnAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const path = storePath(storeId, "offers");
  const data = parseAddOn(fd, path);
  const count = await db.addOn.count({ where: { storeId } });
  await db.addOn.create({ data: { storeId, ...data, position: count } });
  back(path, { ok: "Option ajoutée" });
}

export async function updateAddOnAction(storeId: string, id: string, fd: FormData) {
  await getStore(storeId);
  const path = storePath(storeId, "offers");
  const data = parseAddOn(fd, path);
  const updated = await db.addOn.updateMany({ where: { id, storeId }, data });
  if (updated.count === 0) back(path, { error: "Option introuvable" });
  back(path, { ok: `Option « ${data.title} » mise à jour` });
}

export async function toggleAddOnAction(storeId: string, id: string) {
  await getStore(storeId);
  const a = await db.addOn.findUniqueOrThrow({ where: { id, storeId } });
  await db.addOn.update({ where: { id }, data: { active: !a.active } });
  back(storePath(storeId, "offers"));
}

export async function deleteAddOnAction(storeId: string, id: string) {
  await getStore(storeId);
  await db.addOn.delete({ where: { id, storeId } });
  back(storePath(storeId, "offers"), { ok: "Option supprimée" });
}

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */

export async function resyncOrderAction(storeId: string, sessionId: string) {
  await getStore(storeId);
  const path = storePath(storeId, `orders/${sessionId}`);
  // Manual sync is the merchant's decision on an order held for review.
  await db.checkoutSession.updateMany({ where: { id: sessionId, storeId }, data: { reviewNote: null } });
  try {
    await syncOrder(sessionId);
  } catch (err) {
    back(path, { error: `Échec de la synchronisation : ${errorMessage(err)}` });
  }
  // syncOrder returns quietly when it could not claim the order: say why, never "synchronisée".
  const after = await db.checkoutSession.findUnique({
    where: { id: sessionId },
    select: { status: true, shopifyOrderId: true, shopifyOrderName: true, syncHandledAt: true, syncSkippedReason: true, syncStartedAt: true, syncAmbiguousAt: true },
  });
  revalidatePath(storePath(storeId), "layout");
  if (after?.shopifyOrderId) back(path, { ok: `Commande ${after.shopifyOrderName ?? ""} synchronisée dans Shopify`.replace("  ", " ") });
  if (!after || after.status !== "PAID") back(path, { error: "Seule une commande payée peut être créée dans Shopify." });
  if (after.syncSkippedReason) back(path, { ok: syncSkipMessage(after.syncSkippedReason as SyncSkipReason) });
  if (after.syncHandledAt) back(path, { error: `Cette commande est liée à la main à ${after.shopifyOrderName ?? "une commande Shopify"} : aucune création automatique.` });
  const { AMBIGUOUS_WAIT_MS, SYNC_LEASE_MS } = await import("@/lib/checkout");
  const minutesLeft = (from: Date | null, window: number) => (from ? Math.max(1, Math.ceil((window - (Date.now() - from.getTime())) / 60_000)) : 0);
  if (after.syncAmbiguousAt && Date.now() - after.syncAmbiguousAt.getTime() < AMBIGUOUS_WAIT_MS)
    back(path, {
      error: `Shopify n'a pas répondu au dernier essai : la commande existe peut-être déjà. Réessayez dans ${minutesLeft(after.syncAmbiguousAt, AMBIGUOUS_WAIT_MS)} min (vérification anti-doublon).`,
    });
  if (after.syncStartedAt && Date.now() - after.syncStartedAt.getTime() < SYNC_LEASE_MS)
    back(path, { error: `Une création de cette commande est déjà en cours : réessayez dans ${minutesLeft(after.syncStartedAt, SYNC_LEASE_MS)} min si elle n'apparaît pas.` });
  back(path, { error: "La commande n'a pas été créée dans Shopify. Consultez le journal de la commande." });
}

/** Retries the Shopify order creation for a paid order (failures are logged and rescheduled by the sync itself). */
export async function retryShopifySyncAction(storeId: string, sessionId: string) {
  await getStore(storeId);
  const path = storePath(storeId, `orders/${sessionId}`);
  const session = await db.checkoutSession.findFirst({ where: { id: sessionId, storeId }, select: { status: true, shopifyOrderId: true, syncAmbiguousAt: true, syncHandledAt: true, syncSkippedReason: true } });
  if (!session) back(path, { error: "Commande introuvable" });
  if (session.status !== "PAID") back(path, { error: "Seule une commande payée peut être créée dans Shopify." });
  if (session.syncSkippedReason) back(path, { ok: syncSkipMessage(session.syncSkippedReason as SyncSkipReason) });
  if (session.shopifyOrderId || session.syncHandledAt) back(path, { ok: "Cette commande existe déjà dans Shopify." });
  // Shopify may have created the order during the failed attempt: its search needs a few
  // minutes to see it, and retrying earlier could create a duplicate.
  if (session.syncAmbiguousAt && Date.now() - session.syncAmbiguousAt.getTime() < 5 * 60_000) {
    const wait = Math.ceil((5 * 60_000 - (Date.now() - session.syncAmbiguousAt.getTime())) / 60_000);
    back(path, { error: `Shopify n'a pas répondu au dernier essai : la commande existe peut-être déjà. Réessayez dans ${wait} min (vérification anti-doublon).` });
  }
  await syncOrderSafely(sessionId);
  const after = await db.checkoutSession.findUnique({ where: { id: sessionId }, select: { shopifyOrderName: true, shopifyOrderId: true, syncError: true, syncSkippedReason: true } });
  revalidatePath(storePath(storeId), "layout");
  if (after?.shopifyOrderId) back(path, { ok: `Commande ${after.shopifyOrderName ?? ""} créée dans Shopify`.replace("  ", " ") });
  if (after?.syncSkippedReason) back(path, { ok: syncSkipMessage(after.syncSkippedReason as SyncSkipReason) });
  back(path, { error: `La synchronisation a encore échoué${after?.syncError ? ` : ${after.syncError}` : ""}. Un nouvel essai automatique est programmé.` });
}

export async function refundOrderAction(storeId: string, sessionId: string, fd: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, `orders/${sessionId}`);
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId, storeId } });
  if (!session?.whopPaymentId) back(path, { error: "Paiement introuvable" });
  const remaining = session.totalCents - session.refundedCents;
  const raw = str(fd, "amount");
  const amount = raw ? cents(raw) : remaining;
  if (amount == null || amount <= 0 || amount > remaining) back(path, { error: "Montant de remboursement invalide", field: "amount" });
  const full = amount === remaining;
  const amountLabel = `${centsToDecimal(amount).replace(".", ",")} ${session.currency}`;
  // Refunded where it was paid: Whop, or Stripe (on the connected account).
  const stripe = session.paymentProvider === "stripe";
  const via = stripe ? "Stripe" : "Whop";
  if (stripe) {
    // A past account whose access was removed (disconnected, revoked): the platform can't refund on it
    // any more (Stripe would answer with an authentication error), the merchant can in their Stripe.
    const account = sessionStripeAccount(session, store);
    if (account && account !== store.stripeAccountId && (await pastStripeAccounts(storeId)).some((a) => a.id === account && a.revoked)) {
      back(path, { error: "Ce paiement a été fait sur un ancien compte Stripe déconnecté : remboursez-le depuis votre dashboard Stripe, puis indiquez-le dans Shopify." });
    }
  }
  try {
    // Charged in the buyer's currency: the processor refunds in that currency (the amount typed is in the
    // shop's), the rest being exactly what remains of the charge.
    const providerAmount = providerRefundAmount({
      amountCents: amount,
      totalCents: session.totalCents,
      refundedCents: session.refundedCents,
      chargeTotalCents: session.chargeCurrency && session.chargeFxRate && session.paidQuoteId ? ((await db.checkoutQuote.findUnique({ where: { id: session.paidQuoteId }, select: { chargeTotalCents: true } }))?.chargeTotalCents ?? null) : null,
      refundedChargeCents: session.refundedChargeCents,
      rate: session.chargeFxRate,
      currency: session.chargeCurrency,
    });
    // Same order state + same amount = same key: a double submit or an SDK retry can't refund twice.
    const key = `refund_${session.id}_${(str(fd, "nonce") || `${session.refundedCents}_${amount}`).slice(0, 64)}`;
    if (stripe) {
      // On the account the payment was made on (the store may have disconnected or replaced it since).
      const account = sessionStripeAccount(session, store);
      if (!account) throw new Error("Stripe n'est plus connecté à cette boutique : remboursez depuis votre dashboard Stripe");
      // In the payment's own mode (session.test, from its livemode): still right after a mode switch.
      await refundStripe(stripeForMode(store, !session.test, account), session.whopPaymentId, providerAmount, key, session.chargeCurrency ?? session.currency);
    } else {
      await refundPayment(store, session.whopPaymentId, providerAmount, key);
    }
  } catch (err) {
    await recordEvent({
      storeId,
      sessionId,
      level: "warn",
      kind: "refund.request_failed",
      message: `Remboursement de ${amountLabel} refusé par ${via} : ${errorMessage(err)}`,
      data: { amountCents: amount, paymentId: session.whopPaymentId, provider: session.paymentProvider, source: "dashboard" },
    });
    back(path, { error: `${via} a refusé le remboursement : ${errorMessage(err)}` });
  }
  await recordEvent({
    storeId,
    sessionId,
    kind: "refund.requested",
    message: `Remboursement ${full ? "total" : "partiel"} de ${amountLabel} demandé à ${via} depuis le dashboard`,
    data: { amountCents: amount, full, paymentId: session.whopPaymentId, provider: session.paymentProvider, source: "dashboard" },
  });
  // The processor's refund webhook (refund.created / charge.refunded) records it in Shopify.
  back(path, { ok: `Remboursement de ${amountLabel} demandé à ${via}. Il apparaîtra dans Shopify dès confirmation.` });
}

export type OrderSearchHit = { id: string; shopifyOrderName: string | null; email: string | null; name: string | null; status: string; totalCents: number; currency: string; createdAt: string };

/** ⌘K palette: top 8 orders of the store matching an order number ("#1042", "1042"), an e-mail, the buyer's name or an id. */
export async function searchOrdersAction(storeId: string, q: string): Promise<OrderSearchHit[]> {
  await requireAdmin();
  const term = q.trim().slice(0, 100);
  if (term.length < 2) return [];
  const digits = term.replace(/^#/, "");
  // Buyer name ("Marie Dupont", "dupont marie"): only in the shipping address JSON.
  const byName = /\p{L}/u.test(term) ? await sessionIdsByBuyerName(storeId, term) : [];
  const rows = await db.checkoutSession.findMany({
    where: {
      storeId,
      OR: [
        { shopifyOrderName: { contains: digits, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
        { id: term },
        { whopPaymentId: term },
        ...(byName.length ? [{ id: { in: byName } }] : []),
      ],
    },
    orderBy: [{ paidAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: 8,
    select: { id: true, shopifyOrderName: true, email: true, shippingAddress: true, status: true, totalCents: true, subtotalCents: true, currency: true, createdAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    shopifyOrderName: r.shopifyOrderName,
    email: r.email,
    name: buyerName(r.shippingAddress),
    status: r.status,
    totalCents: r.totalCents || r.subtotalCents,
    currency: r.currency,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** "2026-12-01" → 00:00:00.000 that day in the store's time zone, as a UTC Date (DST-safe). */
function startOfDayIn(day: string, tz: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const check = new Date(`${day}T12:00:00.000Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== day) return null;
  return zonedDayStart(day, tz);
}

/** "2026-12-31" → 23:59:59.999 that day in the store's time zone, as a UTC Date (DST-safe). */
function endOfDayIn(day: string, tz: string): Date | null {
  if (!startOfDayIn(day, tz)) return null;
  return new Date(zonedDayStart(addDays(day, 1), tz).getTime() - 1);
}

/* ------------------------------------------------------------------ */
/* Growth: ads tracking, alerts, dispute shield, payment methods       */
/* ------------------------------------------------------------------ */

/** Keeps a stored secret when the field is left blank ("•••• enregistré"). */
function secretField(fd: FormData, key: string, current: string | null, path: string): string | null {
  if (fd.get(`${key}Clear`) === "on") return null;
  const v = str(fd, key);
  return v ? encryptOrBack(v, path) : current;
}

export async function saveTrackingAction(storeId: string, fd: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "growth");
  const metaPixelId = str(fd, "metaPixelId").replace(/\D/g, "").slice(0, 30) || null;
  const tiktokPixelId = str(fd, "tiktokPixelId").replace(/[^A-Za-z0-9]/g, "").slice(0, 40) || null;
  // Absent from older forms: keep the current mode. Anything else than the two modes is refused.
  const modeRaw = fd.has("conversionValueMode") ? str(fd, "conversionValueMode") : store.conversionValueMode;
  if (modeRaw !== "revenue" && modeRaw !== "profit") back(path, { error: "Valeur de conversion inconnue : choisissez le montant de la commande ou la marge HT." });
  const conversionValueMode = modeRaw;
  await db.store.update({
    where: { id: storeId },
    data: {
      metaPixelId,
      metaAccessToken: secretField(fd, "metaAccessToken", store.metaAccessToken, path),
      metaTestEventCode: str(fd, "metaTestEventCode").slice(0, 40) || null,
      tiktokPixelId,
      tiktokAccessToken: secretField(fd, "tiktokAccessToken", store.tiktokAccessToken, path),
      ga4MeasurementId: /^G-[A-Z0-9]{4,20}$/i.test(str(fd, "ga4MeasurementId")) ? str(fd, "ga4MeasurementId").toUpperCase() : null,
      ga4ApiSecret: secretField(fd, "ga4ApiSecret", store.ga4ApiSecret, path),
      pixelRequireConsent: fd.get("pixelRequireConsent") === "on",
      metaContentIdFormat: str(fd, "metaContentIdFormat") === "shopify" ? "shopify" : "variant",
      metaCatalogCountry: /^[A-Za-z]{2}$/.test(str(fd, "metaCatalogCountry")) ? str(fd, "metaCatalogCountry").toUpperCase() : "FR",
      conversionValueMode,
    },
  });
  // Kept per day on the imported ad spend: a platform's reported value is a margin on "profit" days.
  await recordValueModeChange(storeId, store.conversionValueMode, conversionValueMode).catch(() => undefined);
  back(path, { ok: "Pixels enregistrés" });
}

export async function testTrackingAction(storeId: string) {
  await getStore(storeId);
  const path = storePath(storeId, "growth");
  try {
    const n = await testConversions(storeId);
    if (n === 0) back(path, { error: "Aucun pixel complet (ID + jeton) n'est configuré." });
  } catch (err) {
    if (isRedirect(err)) throw err;
    back(path, { error: `Test refusé : ${errorMessage(err)}` });
  }
  back(path, { ok: "Événement de test envoyé. Vérifiez « Événements de test » dans Meta / TikTok." });
}

export async function saveAlertsAction(storeId: string, fd: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "settings");
  const alertEmail = str(fd, "alertEmail").slice(0, 200) || null;
  if (alertEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alertEmail)) back(path, { error: "E-mail d'alerte invalide", field: "alertEmail" });
  const emailFrom = str(fd, "emailFrom").slice(0, 200) || null;
  if (emailFrom && !/^([^<>]+<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(emailFrom)) {
    back(path, { error: "Expéditeur invalide : ex. « Alertes <alertes@maboutique.fr> »", field: "emailFrom" });
  }
  await db.store.update({
    where: { id: storeId },
    data: {
      alertEmail,
      emailFrom,
      resendApiKey: secretField(fd, "resendApiKey", store.resendApiKey, path),
      telegramBotToken: secretField(fd, "telegramBotToken", store.telegramBotToken, path),
      telegramChatId: str(fd, "telegramChatId").replace(/[^\d-]/g, "").slice(0, 30) || null,
    },
  });
  back(path, { ok: "Alertes enregistrées" });
}

export async function testAlertAction(storeId: string) {
  await getStore(storeId);
  const path = storePath(storeId, "settings");
  try {
    await sendAlert(storeId, "Test d'alerte : tout fonctionne ✅", null);
  } catch (err) {
    back(path, { error: `Échec de l'alerte : ${errorMessage(err)}` });
  }
  back(path, { ok: "Alerte de test envoyée (Telegram et/ou e-mail)." });
}

export async function saveShieldAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const path = storePath(storeId, "settings");
  const raw = str(fd, "statementDescriptor");
  const descriptor = raw ? statementDescriptor(raw) : null;
  if (raw && !descriptor) back(path, { error: "Libellé bancaire : il doit contenir au moins une lettre.", field: "statementDescriptor" });
  await db.store.update({
    where: { id: storeId },
    data: {
      pushTracking: fd.get("pushTracking") === "on",
      autoDisputeEvidence: fd.get("autoDisputeEvidence") === "on",
      autoRefundFraudAlerts: fd.get("autoRefundFraudAlerts") === "on",
      statementDescriptor: descriptor,
    },
  });
  back(path, { ok: "Bouclier anti-litiges enregistré" });
}

/* ------------------------------------------------------------------ */
/* Quantity breaks (offers), margins, fallback, relay points (shipping) */
/* ------------------------------------------------------------------ */

/**
 * Quantity breaks v2 form → raw tiers: one `tier` field per row ("percent:<key>" /
 * "gift:<key>") with its own fields; scoped rows post their products as JSON
 * `{id, title}` under `scope-<key>` (titles are kept to show the chips again).
 */
function parseQuantityBreaksForm(fd: FormData): { ok: true; raw: Record<string, unknown>[]; titles: Record<string, string> } | { ok: false; error: string } {
  const text = (name: string) => String(fd.get(name) ?? "").trim();
  const titles: Record<string, string> = {};
  const raw: Record<string, unknown>[] = [];
  const rows = fd.getAll("tier").map(String);
  if (rows.length > MAX_PERCENT_TIERS + MAX_GIFT_TIERS) return { ok: false, error: "Trop de paliers" };
  for (const row of rows) {
    const m = /^(percent|gift):(\d{1,6})$/.exec(row);
    if (!m) return { ok: false, error: "Paliers illisibles : réessayez" };
    const [, kind, key] = m;
    const scope: string[] = [];
    for (const item of fd.getAll(`scope-${key}`)) {
      let p: unknown = null;
      try {
        p = JSON.parse(String(item));
      } catch {
        /* rejected below */
      }
      const id = (p as { id?: unknown })?.id;
      const title = (p as { title?: unknown })?.title;
      if (typeof id !== "string" || !/^gid:\/\/shopify\/Product\/\d+$/.test(id)) return { ok: false, error: "Produit Shopify invalide dans un palier" };
      if (!scope.includes(id)) scope.push(id);
      if (typeof title === "string" && title.trim()) titles[id] = title.trim().slice(0, 120);
    }
    // "Only some products" without any product would silently apply to the whole cart.
    if (fd.get(`scopeMode-${key}`) === "some" && !scope.length) return { ok: false, error: "choisissez au moins un produit pour un palier « certains produits »" };
    const scoped = scope.length ? { productIds: scope } : {};
    if (kind === "percent") {
      // Discount tier of any format (percent, amount off, bundle price, buy X get Y): validated by pricing.ts.
      const minQty = Number(text(`minQty-${key}`));
      const dec = (name: string) => Number(text(name).replace(/\s/g, "").replace(",", "."));
      // Amounts: 2 decimals at most ("4,995" is refused by the tier check, not rounded to 5,00).
      const money = (name: string) => (/[.,]\d{3,}$/.test(text(name).replace(/\s/g, "")) ? NaN : dec(name));
      const format = text(`format-${key}`) || "percent";
      if (format === "amount") raw.push({ kind: "amount", minQty, amountCents: Math.round(money(`amount-${key}`) * 100), per: text(`per-${key}`) === "bundle" ? "bundle" : "unit", ...scoped });
      else if (format === "price") raw.push({ kind: "price", minQty, priceCents: Math.round(money(`price-${key}`) * 100), ...scoped });
      else if (format === "bxgy") raw.push({ kind: "bxgy", minQty, freeQty: Number(text(`freeQty-${key}`) || "1"), ...scoped });
      else if (format === "percent") raw.push({ minQty, percent: dec(`percent-${key}`), ...scoped });
      else return { ok: false, error: "Type de palier inconnu" };
    } else {
      const thresholdRaw = text(`giftThreshold-${key}`).replace(/\s/g, "");
      const threshold = /[.,]\d{3,}$/.test(thresholdRaw) ? NaN : Number(thresholdRaw.replace(",", "."));
      const byQty = text(`giftMode-${key}`) === "qty";
      raw.push({
        type: "gift",
        variantId: text(`giftVariant-${key}`),
        title: text(`giftTitle-${key}`),
        ...(() => {
          // Buyer-language names ({ [lang]: { title } }), from the row's translations panel.
          const t = cleanRecordI18n(fd.get(`giftI18n-${key}`), ["title"]);
          return t ? { i18n: t } : {};
        })(),
        ...(byQty ? { minQty: threshold } : { minSubtotalCents: Math.round(threshold * 100) }),
        ...scoped,
      });
    }
  }
  return { ok: true, raw, titles };
}

export async function saveQuantityBreaksAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const path = storePath(storeId, "offers");
  const form = parseQuantityBreaksForm(fd);
  if (!form.ok) back(path, { error: `Remises par quantité : ${form.error}` });
  // Same rules as the checkout (pricing.ts): nothing the checkout would drop is saved.
  const checked = validateQuantityTiers(form.raw);
  if (!checked.ok) back(path, { error: `Remises par quantité : ${checked.error}` });
  const tiers = checked.tiers.map((t) =>
    t.productIds?.length ? { ...t, productTitles: Object.fromEntries(t.productIds.filter((id) => form.titles[id]).map((id) => [id, form.titles[id]])) } : t,
  );
  await db.store.update({ where: { id: storeId }, data: { quantityBreaks: tiers.length ? (tiers as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
  revalidatePath(storePath(storeId), "layout");
  back(path, { ok: tiers.length ? "Remises par quantité et cadeaux enregistrés" : "Remises par quantité désactivées" });
}

export async function saveMarginsAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const path = storePath(storeId, "settings");
  const feeRaw = str(fd, "fulfillmentFee");
  const fee = feeRaw ? cents(feeRaw) : 0;
  if (fee == null || fee > 100_000) back(path, { error: "Coût de préparation invalide (ex. 1,50 ; 1 000 max.)", field: "fulfillmentFee" });
  const homeCountry = (str(fd, "homeCountry") || "FR").toUpperCase();
  if (!EU_VAT_AREA.has(homeCountry) || STANDARD_VAT_RATES[homeCountry] == null) back(path, { error: "Pays d'établissement invalide (pays de l'Union européenne ou Monaco)", field: "homeCountry" });
  await db.store.update({
    where: { id: storeId },
    data: {
      homeCountry,
      vatExempt: fd.get("vatExempt") === "on",
      vatDomesticOnly: fd.get("vatDomesticOnly") === "on",
      adSpendVatNonReclaimable: fd.get("adSpendVatNonReclaimable") === "on",
      fulfillmentFeeCents: fee,
    },
  });
  revalidatePath(storePath(storeId), "layout");
  back(path, { ok: "Marges enregistrées" });
}

/** Shopify › "Offres post-achat": merge one-click offers into the checkout's order (opt-in) and its window. */
export async function saveOfferMergeAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const path = storePath(storeId, "shopify");
  const mergeOffersIntoOrder = fd.get("mergeOffersIntoOrder") === "on";
  const windowMin = Number(str(fd, "offerMergeWindowMin") || "10");
  if (!Number.isInteger(windowMin) || windowMin < 1 || windowMin > 1440) back(path, { error: "Fenêtre d'ajout invalide (1 à 1 440 minutes)", field: "offerMergeWindowMin" });
  await db.store.update({ where: { id: storeId }, data: { mergeOffersIntoOrder, offerMergeWindowMin: windowMin } });
  await recordEvent({
    storeId,
    kind: "settings.offer_merge",
    message: mergeOffersIntoOrder
      ? `Offres post-achat ajoutées à la commande d'origine pendant ${windowMin} min après la commande (sinon commande séparée)`
      : "Offres post-achat : toujours une commande Shopify séparée",
  });
  revalidatePath(storePath(storeId), "layout");
  back(path, { ok: "Réglage des offres post-achat enregistré" });
}

export async function saveFallbackAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const autoFallback = fd.get("autoFallback") === "on";
  await db.store.update({ where: { id: storeId }, data: { autoFallback } });
  back(storePath(storeId, "settings"), { ok: autoFallback ? "Checkout de secours activé" : "Checkout de secours désactivé" });
}

export async function clearFallbackAction(storeId: string) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "settings");
  if (!store.fallbackActiveAt) back(path, { ok: "Le checkout Whop est déjà actif" });
  await db.store.update({ where: { id: storeId }, data: { fallbackActiveAt: null, fallbackReason: null } });
  await closeFallbackPeriod(storeId);
  await recordEvent({
    storeId,
    kind: "fallback.cleared_manually",
    message: "Checkout Whop réactivé manuellement depuis les réglages (le checkout Shopify de secours n'est plus utilisé).",
    data: { since: store.fallbackActiveAt.toISOString(), reason: store.fallbackReason },
  });
  revalidatePath(storePath(storeId), "layout");
  back(path, { ok: "Checkout Whop réactivé. Si Whop échoue encore, le secours se réenclenchera tout seul." });
}

export async function savePickupAction(storeId: string, fd: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "shipping");
  const enseigne = str(fd, "mondialRelayEnseigne").toUpperCase();
  if (enseigne && !/^[A-Z0-9]{2,10}$/.test(enseigne)) back(path, { error: "Code enseigne Mondial Relay invalide (ex. BDTEST13)", field: "mondialRelayEnseigne" });
  const key = secretField(fd, "mondialRelayKey", store.mondialRelayKey, path);
  await db.store.update({ where: { id: storeId }, data: { mondialRelayEnseigne: enseigne || null, mondialRelayKey: key } });
  const ready = !!enseigne && !!key;
  const pickupRates = await db.shippingRate.count({ where: { storeId, kind: "pickup", active: true } });
  back(path, {
    ok: !ready
      ? "Point relais enregistré (incomplet : code enseigne et clé sont nécessaires)"
      : pickupRates
        ? "Mondial Relay enregistré"
        : "Mondial Relay enregistré. Ajoutez un tarif de type « Point relais » ci-dessous pour le proposer.",
  });
}

export async function testPickupAction(storeId: string) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "shipping");
  if (!pickupConfigured(store)) back(path, { error: "Enregistrez d'abord le code enseigne et la clé privée Mondial Relay." });
  let found = 0;
  try {
    found = (await searchPickupPoints(store, { country: "FR", zip: "75002" })).length;
  } catch (err) {
    back(path, { error: `Test Mondial Relay échoué : ${errorMessage(err)}` });
  }
  if (!found) back(path, { error: "Mondial Relay répond mais ne trouve aucun point relais autour de Paris 2ᵉ (75002) : vérifiez le code enseigne." });
  back(path, { ok: `Mondial Relay fonctionne : ${found} point${found > 1 ? "s" : ""} relais trouvé${found > 1 ? "s" : ""} autour de Paris 2ᵉ (75002).` });
}

export async function savePaymentMethodsAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const methods = fd.getAll("methods").map(String).filter((m) => OPTIONAL_PAYMENT_METHOD_IDS.includes(m));
  await db.store.update({ where: { id: storeId }, data: { paymentMethods: methods } });
  back(storePath(storeId, "whop"), {
    ok: methods.length ? `${methods.length} moyen(s) de paiement ajouté(s) au checkout` : "Moyens de paiement locaux désactivés",
  });
}

/** Brings back the PayPal express button Whop's refusal hid (24 h hold): the next checkout asks Whop again. */
export async function reactivatePaypalAction(storeId: string) {
  await getStore(storeId);
  const cleared = await clearPaypalRefusals(storeId);
  if (cleared) await recordEvent({ storeId, kind: "paypal.reactivated", message: "PayPal express réactivé depuis le dashboard : Whop sera de nouveau consulté au prochain checkout." });
  revalidatePath(storePath(storeId), "layout");
  back(storePath(storeId, "whop"), { ok: cleared ? "PayPal réactivé : Whop sera de nouveau consulté au prochain checkout." : "PayPal n'était pas masqué." });
}

/** Re-creates the Whop webhook with the current event list (e.g. after an app update). */
export async function refreshWhopWebhookAction(storeId: string) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "whop");
  if (!store.whopApiKey) back(path, { error: "Connectez Whop d'abord" });
  let result;
  try {
    result = await setupWhop({
      apiKey: decrypt(store.whopApiKey),
      testMode: store.testMode,
      storeId,
      storeName: store.name,
      statementDescriptor: store.statementDescriptor,
    });
  } catch (err) {
    back(path, { error: `Whop a refusé la mise à jour : ${errorMessage(err)}` });
  }
  await db.store.update({
    where: { id: storeId },
    data: {
      whopProductId: result.productId,
      whopWebhookId: result.webhookId,
      whopWebhookSecret: encryptOrBack(result.webhookSecret, path),
    },
  });
  await reregisterApplePayDomain(storeId);
  back(path, { ok: "Webhook Whop mis à jour (alertes de fraude incluses)." });
}

/* ------------------------------------------------------------------ */
/* Settings page: one save bar for every section                       */
/* ------------------------------------------------------------------ */

/** Section key (the DirtyForm label) → the action that saves it. */
/**
 * Checkout options (Réglages): Shopify discount codes, charging in the buyer's currency and the
 * "Déjà client ?" e-mail code. The e-mail code needs a Resend key and sender (Alertes).
 */
export async function saveCheckoutOptionsAction(storeId: string, fd: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "settings");
  const returningBuyerCode = fd.get("returningBuyerCode") === "on";
  if (returningBuyerCode && !(await buyerEmailAvailable(store))) {
    back(path, { field: "returningBuyerCode", error: "« Déjà client ? » envoie le code par e-mail : renseignez d'abord la clé Resend et l'expéditeur (section Alertes), ou le compte Resend de l'opérateur (section Réseau)." });
  }
  await db.store.update({
    where: { id: storeId },
    data: {
      shopifyDiscountCodes: fd.get("shopifyDiscountCodes") === "on",
      chargeLocalCurrency: fd.get("chargeLocalCurrency") === "on",
      returningBuyerCode,
      storeNetwork: fd.get("storeNetwork") === "on",
      breaksCombineWithCodes: fd.get("breaksCombineWithCodes") === "on",
    },
  });
  revalidatePath(path);
  back(path, { ok: "Options du checkout enregistrées" });
}

async function settingsSectionAction(key: string): Promise<((storeId: string, fd: FormData) => Promise<void>) | null> {
  switch (key) {
    case "Boutique":
      return saveSettingsAction;
    case "Checkout de secours":
      return saveFallbackAction;
    case "Marges & coûts":
      return saveMarginsAction;
    case "Coûts":
      return (await import("./stores/[storeId]/(main)/analytics/actions")).saveCostsAction;
    case "Alertes":
      return saveAlertsAction;
    case "Bouclier anti-litiges":
      return saveShieldAction;
    case "Options du checkout":
      return saveCheckoutOptionsAction;
    case "Domaine du checkout":
      return saveCheckoutDomainAction;
    default:
      return null;
  }
}

/** The ok / error flash of a redirect thrown by a section action. */
function redirectFlash(err: unknown): FlashParams | null {
  if (!isRedirect(err)) return null;
  const url = String((err as { digest: string }).digest).split(";").slice(2, -2).join(";");
  const q = new URL(url, "http://x").searchParams;
  return { ok: q.get("ok") ?? undefined, error: q.get("error") ?? undefined, field: q.get("field") ?? undefined };
}

/**
 * Saves several settings sections at once (the save bar, when more than one card changed).
 * Fields arrive as "<section>::<name>"; each section runs its own action and validation, in
 * page order, and the first error stops the rest.
 */
export async function saveSettingsBatchAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const path = storePath(storeId, "settings");
  const sections = fd.getAll("__section").map(String);
  const oks: string[] = [];
  for (const key of sections) {
    const action = await settingsSectionAction(key);
    if (!action) back(path, { error: `Section inconnue : ${key}` });
    const sub = new FormData();
    for (const [k, v] of fd.entries()) if (k.startsWith(`${key}::`)) sub.append(k.slice(key.length + 2), v);
    try {
      await action(storeId, sub);
    } catch (err) {
      const flash = redirectFlash(err);
      if (!flash) throw err;
      if (flash.error) back(path, { error: `${key} : ${flash.error}${oks.length ? ` (déjà enregistré : ${oks.join(", ")})` : ""}`, field: flash.field, form: key });
      oks.push(key);
      continue;
    }
    oks.push(key);
  }
  revalidatePath(storePath(storeId), "layout");
  const ok = oks.length > 1 ? `${oks.length} sections enregistrées : ${oks.join(", ")}` : oks.length ? `${oks[0]} : enregistré` : "Rien à enregistrer";
  // "saved" makes every batch land on a new URL: the save bar waits for it to reset the forms.
  redirect(`${path}?${new URLSearchParams({ ok, saved: String(Date.now()) })}`);
}

function isRedirect(err: unknown) {
  return err instanceof Error && "digest" in err && String((err as { digest?: string }).digest).startsWith("NEXT_REDIRECT");
}

/**
 * Items the automation gave up on (refund mirrors, alerts, Whop events): start their
 * retries over now. For when the cause was fixed (Shopify reconnected, Telegram token…).
 */
export async function retryGaveUpAction(storeId: string) {
  await getStore(storeId);
  const { retryGaveUp } = await import("@/lib/maintenance");
  const n = await retryGaveUp(storeId);
  await recordEvent({ storeId, kind: "maintenance.retry_all", message: `Relance manuelle de ${n} élément(s) abandonné(s) par l'automatisation.` });
  const { runTick } = await import("@/lib/tick");
  await runTick();
  back(storePath(storeId, "journal"), { ok: n ? `${n} élément(s) relancé(s). Voir l'état ci-dessous.` : "Rien à relancer." });
}

/** The merchant handled them by hand (refund reported in Shopify, event checked in Whop): stop flagging. */
export async function markGaveUpHandledAction(storeId: string) {
  await getStore(storeId);
  const { markGaveUpHandled } = await import("@/lib/maintenance");
  const n = await markGaveUpHandled(storeId);
  await recordEvent({ storeId, level: "warn", kind: "maintenance.marked_handled", message: `${n} élément(s) abandonné(s) marqué(s) comme traités à la main.` });
  back(storePath(storeId, "journal"), { ok: n ? `${n} élément(s) marqué(s) comme traités.` : "Rien à marquer." });
}

/** One gave-up item from the journal list: retry it now, or mark it handled by hand. */
export async function gaveUpItemAction(storeId: string, kind: string, id: string, fd: FormData) {
  await getStore(storeId);
  const path = storePath(storeId, "journal");
  const { GAVE_UP_KINDS, gaveUpItem } = await import("@/lib/maintenance");
  if (!(GAVE_UP_KINDS as readonly string[]).includes(kind)) back(path, { error: "Élément inconnu." });
  const handled = str(fd, "op") === "handled";
  // Handling a missing Shopify order means linking the order made by hand: done on the order page.
  if (kind === "sync" && handled) back(storePath(storeId, `orders/${id}`), { error: "Indiquez ci-dessous le numéro de la commande créée à la main dans Shopify." });
  const n = await gaveUpItem(storeId, kind as (typeof GAVE_UP_KINDS)[number], id, handled);
  if (!n) back(path, { error: "Cet élément a déjà été relancé ou traité." });
  await recordEvent({
    storeId,
    level: handled ? "warn" : "info",
    kind: handled ? "maintenance.marked_handled" : "maintenance.retry_one",
    message: handled ? `Élément abandonné (${kind}) marqué comme traité à la main.` : `Relance manuelle d'un élément abandonné (${kind}).`,
    data: { kind, id },
  });
  if (!handled) {
    const { runTick } = await import("@/lib/tick");
    await runTick();
  }
  back(path, { ok: handled ? "Marqué comme traité." : "Relancé. Voir l'état ci-dessous." });
}

/**
 * The merchant created the Shopify order by hand (the automatic sync gave up or was
 * wrong): link it so nothing ever creates another one, and stop flagging it.
 */
export async function markOrderHandledAction(storeId: string, sessionId: string, fd: FormData) {
  await getStore(storeId);
  const path = storePath(storeId, `orders/${sessionId}`);
  const name = str(fd, "orderName").slice(0, 40);
  if (!/^#?[A-Za-z0-9-]{1,30}$/.test(name)) back(path, { error: "Indiquez le numéro de la commande Shopify créée à la main (ex. #1234).", field: "orderName" });
  const { linkOrderByHand } = await import("@/lib/maintenance");
  const res = await linkOrderByHand(storeId, sessionId, name);
  if (!res.ok)
    back(path, {
      error:
        res.reason === "in_progress"
          ? "Une création automatique de cette commande est en cours : attendez 2 min et vérifiez Shopify avant de lier une commande faite à la main."
          : res.reason === "already_linked"
            ? "Cette commande est déjà liée à Shopify."
            : "Commande introuvable ou non payée.",
    });
  await recordEvent({ storeId, sessionId, level: "warn", kind: "order.linked_manually", message: `Commande liée à la main à ${name} dans Shopify : plus aucune création automatique.` });
  revalidatePath(storePath(storeId), "layout");
  back(path, { ok: "Commande liée. Les remboursements et litiges de cette commande sont à reporter à la main dans Shopify (une alerte vous le rappellera)." });
}

export async function runTickAction(storeId: string) {
  await getStore(storeId);
  const { runTick } = await import("@/lib/tick");
  const report = await runTick();
  back(storePath(storeId, "journal"), {
    ok: `Maintenance terminée : ${Number(report.reconciled) || 0} paiement(s) récupéré(s), ${Number(report.syncRetried) || 0} synchro(s) relancée(s).`,
  });
}

/**
 * Operator-level Resend account (Réglages › Réseau): one key and sender for the buyer e-mails of
 * every store without its own Resend account. Blank key keeps the stored one; "clear" removes it.
 */
export async function saveOperatorMailAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const path = storePath(storeId, "settings");
  const key = str(fd, "operatorResendApiKey");
  const from = str(fd, "operatorEmailFrom").slice(0, 200);
  if (fd.get("operatorResendApiKeyClear") === "on") {
    await db.appSetting.deleteMany({ where: { key: { in: [OPERATOR_KEY_SETTING, OPERATOR_FROM_SETTING] } } });
    back(path, { ok: "Compte Resend de l'opérateur supprimé." });
  }
  if (from && !/^([^<>]{1,80}<)?[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+>?$/.test(from)) back(path, { error: "Expéditeur invalide (ex. Boutiques <noreply@mondomaine.fr>).", field: "operatorEmailFrom" });
  if (key && !/^re_[\w-]{10,200}$/.test(key)) back(path, { error: "Clé Resend invalide (commence par re_).", field: "operatorResendApiKey" });
  const ops = [];
  if (key) ops.push(db.appSetting.upsert({ where: { key: OPERATOR_KEY_SETTING }, create: { key: OPERATOR_KEY_SETTING, value: encrypt(key) }, update: { value: encrypt(key) } }));
  if (from) ops.push(db.appSetting.upsert({ where: { key: OPERATOR_FROM_SETTING }, create: { key: OPERATOR_FROM_SETTING, value: from }, update: { value: from } }));
  if (ops.length) await db.$transaction(ops);
  revalidatePath(path);
  back(path, { ok: "Compte Resend de l'opérateur enregistré : il envoie les e-mails clients des boutiques sans clé Resend." });
}
