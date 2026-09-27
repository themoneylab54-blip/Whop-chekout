"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { login, logout, requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { encrypt, randomToken } from "@/lib/crypto";
import {
  checkoutLayoutSchema,
  interceptionSchema,
  themeSchema,
  thankYouLayoutSchema,
  type Layout,
  type Theme,
} from "@/lib/layout";
import { ensureScriptTag, installUrl, normalizeShopDomain, removeScriptTag } from "@/lib/shopify";
import { refundPayment, registerApplePayDomain, setupWhop, teardownWhop } from "@/lib/whop";
import { env } from "@/lib/env";
import { syncOrder } from "@/lib/checkout";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function back(path: string, params: { ok?: string; error?: string } = {}): never {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
  redirect(q.size ? `${path}?${q}` : path);
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

/** "12,50" | "12.5" | "12" → 1250 cents. Returns null when empty or invalid. */
function cents(value: string): number | null {
  if (!value) return null;
  const n = Number(value.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/** Encrypts before any external call so a misconfigured key fails cleanly, with nothing half-created. */
function encryptOrBack(value: string, path: string): string {
  try {
    return encrypt(value);
  } catch (err) {
    console.error("encryption failed", err);
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

export async function loginAction(fd: FormData) {
  const ok = await login(str(fd, "email"), String(fd.get("password") ?? ""));
  if (!ok) back("/login", { error: "E-mail ou mot de passe incorrect" });
  redirect("/dashboard");
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
  if (store.scriptTagId && store.shopifyAccessToken) {
    await removeScriptTag(store, store.scriptTagId).catch(() => undefined);
  }
  await teardownWhop(store).catch(() => undefined);
  await db.store.delete({ where: { id: storeId } });
  redirect("/dashboard");
}

export async function saveSettingsAction(storeId: string, fd: FormData) {
  const store = await getStore(storeId);
  const testMode = fd.get("testMode") === "on";
  const name = str(fd, "name").slice(0, 80) || store.name;
  const modeChanged = testMode !== store.testMode;
  if (modeChanged && store.whopConnectedAt) {
    // Sandbox and production use different Whop keys: the connection must be redone.
    await teardownWhop(store).catch(() => undefined);
  }
  await db.store.update({
    where: { id: storeId },
    data: {
      name,
      testMode,
      ...(modeChanged && store.whopConnectedAt
        ? {
            enabled: false,
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
  revalidatePath(storePath(storeId), "layout");
  if (modeChanged && store.whopConnectedAt) {
    back(storePath(storeId, "whop"), {
      ok: `Mode ${testMode ? "test" : "production"} activé. Reconnectez Whop avec la clé ${testMode ? "sandbox" : "de production"}.`,
    });
  }
  back(storePath(storeId, "settings"), { ok: "Réglages enregistrés" });
}

export async function setEnabledAction(storeId: string, enabled: boolean) {
  const store = await getStore(storeId);
  if (enabled && (!store.shopifyConnectedAt || !store.whopConnectedAt)) {
    back(storePath(storeId), { error: "Connectez Shopify et Whop avant d'activer le checkout." });
  }
  await db.store.update({ where: { id: storeId }, data: { enabled } });
  revalidatePath(storePath(storeId), "layout");
  back(storePath(storeId), {
    ok: enabled ? "Checkout Whop activé sur la boutique" : "Checkout Whop désactivé : la boutique utilise le checkout Shopify.",
  });
}

/* ------------------------------------------------------------------ */
/* Shopify connection                                                  */
/* ------------------------------------------------------------------ */

export async function startShopifyInstallAction(storeId: string, fd: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "shopify");
  const shop = normalizeShopDomain(str(fd, "shopDomain"));
  if (!shop) back(path, { error: "Domaine invalide : utilisez l'adresse en .myshopify.com" });

  const clientId = str(fd, "clientId") || store.shopifyClientId || "";
  const clientSecret = str(fd, "clientSecret");
  if (!clientId) back(path, { error: "Client ID manquant" });
  if (!clientSecret && !store.shopifyClientSecret) back(path, { error: "Client secret manquant" });

  const other = await db.store.findFirst({ where: { shopDomain: shop, NOT: { id: storeId } } });
  if (other) back(path, { error: `${shop} est déjà connectée à la boutique « ${other.name} ».` });

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
        ? { shopifyAccessToken: null, scriptTagId: null, shopifyConnectedAt: null, enabled: false, storefrontHost: null }
        : {}),
    },
  });
  redirect(installUrl(shop, clientId, state));
}

export async function disconnectShopifyAction(storeId: string) {
  const store = await getStore(storeId);
  if (store.scriptTagId && store.shopifyAccessToken) {
    await removeScriptTag(store, store.scriptTagId).catch(() => undefined);
  }
  await db.store.update({
    where: { id: storeId },
    data: { shopifyAccessToken: null, scriptTagId: null, shopifyConnectedAt: null, shopifyScopes: null, enabled: false },
  });
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
  if (!apiKey) back(path, { error: "Collez votre clé API Whop" });
  const encryptedKey = encryptOrBack(apiKey, path);
  let result;
  try {
    if (store.whopConnectedAt) await teardownWhop(store).catch(() => undefined);
    result = await setupWhop({ apiKey, testMode: store.testMode, storeId, storeName: store.name });
  } catch (err) {
    back(path, { error: `Whop a refusé la connexion : ${errorMessage(err)}` });
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
  revalidatePath(storePath(storeId), "layout");
  back(path, { ok: `Compte Whop « ${result.accountName} » connecté. Produit et webhook créés automatiquement.` });
}

export async function disconnectWhopAction(storeId: string) {
  const store = await getStore(storeId);
  await teardownWhop(store).catch(() => undefined);
  await db.store.update({
    where: { id: storeId },
    data: {
      enabled: false,
      whopApiKey: null,
      whopAccountId: null,
      whopProductId: null,
      whopWebhookId: null,
      whopWebhookSecret: null,
      whopConnectedAt: null,
    },
  });
  revalidatePath(storePath(storeId), "layout");
  back(storePath(storeId, "whop"), { ok: "Whop déconnecté." });
}

/** Saves Apple's domain-association file (from Whop) and registers the checkout domain. */
export async function setupApplePayAction(storeId: string, fd: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "whop");
  const file = String(fd.get("association") ?? "").trim();
  if (file) {
    if (file.length > 20000) back(path, { error: "Fichier Apple Pay trop volumineux : collez uniquement son contenu" });
    await db.appSetting.upsert({
      where: { key: "apple_pay_domain_association" },
      update: { value: file },
      create: { key: "apple_pay_domain_association", value: file },
    });
  }
  let status = "pending";
  try {
    const domain = await registerApplePayDomain(store, new URL(env.appUrl).hostname);
    status = domain.status;
  } catch (err) {
    back(path, { error: `Whop n'a pas pu enregistrer le domaine : ${errorMessage(err)}` });
  }
  if (status === "verified") back(path, { ok: "Apple Pay est activé sur votre checkout" });
  back(path, {
    error: "Domaine enregistré mais pas encore vérifié par Apple. Vérifiez le fichier collé, puis réessayez dans quelques minutes.",
  });
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
  if (!parsed.success) back(storePath(storeId, "interception"), { error: "Réglages invalides" });
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
): Promise<{ ok: true } | { ok: false; error: string }> {
  await getStore(storeId);
  const t = themeSchema.safeParse(theme);
  if (!t.success) return { ok: false, error: `Thème invalide : ${t.error.issues[0]?.path.join(".")} ${t.error.issues[0]?.message}` };
  const l = (page === "checkout" ? checkoutLayoutSchema : thankYouLayoutSchema).safeParse(layout);
  if (!l.success) return { ok: false, error: l.error.issues[0]?.message ?? "Mise en page invalide" };
  await db.store.update({
    where: { id: storeId },
    data: {
      theme: t.data as Prisma.InputJsonValue,
      ...(page === "checkout" ? { checkoutLayout: l.data as Prisma.InputJsonValue } : { thankYouLayout: l.data as Prisma.InputJsonValue }),
    },
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Shipping                                                            */
/* ------------------------------------------------------------------ */

const countriesField = (v: string) =>
  v
    .split(/[\s,;]+/)
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));

export async function saveRateAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const path = storePath(storeId, "shipping");
  const id = str(fd, "id");
  const name = str(fd, "name").slice(0, 80);
  const price = cents(str(fd, "price"));
  if (!name || price == null) back(path, { error: "Nom et prix obligatoires" });
  const data = {
    name,
    deliveryTime: str(fd, "deliveryTime").slice(0, 80) || null,
    countries: countriesField(str(fd, "countries")),
    priceCents: price,
    freeOverCents: cents(str(fd, "freeOver")),
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
    .min(2)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/, "Lettres, chiffres, - et _ uniquement")
    .transform((c) => c.toUpperCase()),
  type: z.enum(["PERCENT", "FIXED", "FREE_SHIPPING"]),
  value: z.string(),
  minSubtotal: z.string(),
  endsAt: z.string(),
  usageLimit: z.string(),
});

export async function createDiscountAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const path = storePath(storeId, "offers");
  const parsed = discountForm.safeParse(Object.fromEntries(fd));
  if (!parsed.success) back(path, { error: parsed.error.issues[0]?.message ?? "Code invalide" });
  const f = parsed.data;
  let value = 0;
  if (f.type === "PERCENT") {
    value = Math.round(Number(f.value.replace(",", ".")));
    if (!(value >= 1 && value <= 100)) back(path, { error: "Pourcentage entre 1 et 100" });
  } else if (f.type === "FIXED") {
    value = cents(f.value) ?? 0;
    if (value <= 0) back(path, { error: "Montant de réduction invalide" });
  }
  const exists = await db.discountCode.findUnique({ where: { storeId_code: { storeId, code: f.code } } });
  if (exists) back(path, { error: `Le code ${f.code} existe déjà` });
  await db.discountCode.create({
    data: {
      storeId,
      code: f.code,
      type: f.type,
      value,
      minSubtotalCents: cents(f.minSubtotal),
      endsAt: f.endsAt ? new Date(f.endsAt) : null,
      usageLimit: f.usageLimit ? Math.max(1, parseInt(f.usageLimit, 10)) : null,
    },
  });
  back(path, { ok: `Code ${f.code} créé` });
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

export async function createAddOnAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const path = storePath(storeId, "offers");
  const title = str(fd, "title").slice(0, 80);
  const price = cents(str(fd, "price"));
  if (!title || price == null || price <= 0) back(path, { error: "Titre et prix obligatoires" });
  const variant = str(fd, "variantId");
  const count = await db.addOn.count({ where: { storeId } });
  await db.addOn.create({
    data: {
      storeId,
      title,
      description: str(fd, "description").slice(0, 200) || null,
      priceCents: price,
      variantId: variant ? (variant.startsWith("gid://") ? variant : `gid://shopify/ProductVariant/${variant.replace(/\D/g, "")}`) : null,
      imageUrl: /^https?:\/\//i.test(str(fd, "imageUrl")) ? str(fd, "imageUrl") : null,
      position: count,
    },
  });
  back(path, { ok: "Option ajoutée" });
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
  const path = storePath(storeId, "orders");
  // Manual retry: release any stale lease first.
  await db.checkoutSession.updateMany({ where: { id: sessionId, storeId }, data: { syncStartedAt: null } });
  try {
    await syncOrder(sessionId);
  } catch (err) {
    back(path, { error: `Échec de la synchronisation : ${errorMessage(err)}` });
  }
  back(path, { ok: "Commande synchronisée dans Shopify" });
}

export async function refundOrderAction(storeId: string, sessionId: string, fd: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, "orders");
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId, storeId } });
  if (!session?.whopPaymentId) back(path, { error: "Paiement introuvable" });
  const remaining = session.totalCents - session.refundedCents;
  const amount = cents(str(fd, "amount")) ?? remaining;
  if (amount <= 0 || amount > remaining) back(path, { error: "Montant de remboursement invalide" });
  try {
    await refundPayment(store, session.whopPaymentId, amount === session.totalCents ? undefined : amount);
  } catch (err) {
    back(path, { error: `Whop a refusé le remboursement : ${errorMessage(err)}` });
  }
  // The refund.created webhook records it in Shopify.
  back(path, { ok: "Remboursement demandé à Whop. Il apparaîtra dans Shopify dès confirmation." });
}
