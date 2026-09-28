"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { rateLimit } from "@/lib/ratelimit";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { login, logout, requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
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
import { draftDesign } from "@/lib/design";
import { recordEvent } from "@/lib/log";
import { sendAlert } from "@/lib/notify";
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

/** Largest amount accepted anywhere in the dashboard (1 000 000.00). */
const MAX_CENTS = 100_000_000;

/** "12,50" | "12.5" | "12" → 1250 cents. Returns null when empty, invalid or absurdly large. */
function cents(value: string): number | null {
  if (!value) return null;
  const n = Number(value.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 && n * 100 <= MAX_CENTS ? Math.round(n * 100) : null;
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
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!(await rateLimit(`login:${ip}`, 10))) back("/login", { error: "Trop de tentatives. Réessayez dans une minute." });
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
    // Set up with the new key first: a wrong key must not break a working connection.
    result = await setupWhop({
      apiKey,
      testMode: store.testMode,
      storeId,
      storeName: store.name,
      statementDescriptor: store.statementDescriptor,
    });
  } catch (err) {
    back(path, { error: `Whop a refusé la connexion : ${errorMessage(err)}` });
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
  // Autosave goes to the draft: buyers keep seeing the published design until "Publier".
  await db.store.update({
    where: { id: storeId },
    data: {
      draftTheme: t.data as Prisma.InputJsonValue,
      ...(page === "checkout"
        ? { draftCheckoutLayout: l.data as Prisma.InputJsonValue }
        : { draftThankYouLayout: l.data as Prisma.InputJsonValue }),
      draftUpdatedAt: new Date(),
    },
  });
  return { ok: true };
}

/** Publishes the drafts (theme + both layouts) and keeps a version in the history. */
export async function publishDesignAction(storeId: string, label: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = await getStore(storeId);
  const design = draftDesign(store);
  const t = themeSchema.safeParse(design.theme);
  const c = checkoutLayoutSchema.safeParse(design.checkoutLayout);
  const y = thankYouLayoutSchema.safeParse(design.thankYouLayout);
  if (!t.success || !c.success || !y.success) return { ok: false, error: "Le brouillon contient une erreur : corrigez-la avant de publier." };
  await db.$transaction([
    db.store.update({
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
    }),
    db.layoutVersion.create({
      data: {
        storeId,
        label: label.trim().slice(0, 80) || `Publication du ${new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" })}`,
        theme: t.data as Prisma.InputJsonValue,
        checkoutLayout: c.data as Prisma.InputJsonValue,
        thankYouLayout: y.data as Prisma.InputJsonValue,
      },
    }),
  ]);
  await recordEvent({ storeId, kind: "design.published", message: "Nouveau design publié sur le checkout" });
  revalidatePath(storePath(storeId), "layout");
  return { ok: true };
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
  const path = storePath(storeId, "analytics");
  const versionId = str(fd, "versionId");
  const split = Math.min(90, Math.max(10, parseInt(str(fd, "split"), 10) || 50));
  const version = await db.layoutVersion.findFirst({ where: { id: versionId, storeId } });
  if (!version) back(path, { error: "Choisissez la version à tester (variante B)." });
  const store = await db.store.findUniqueOrThrow({ where: { id: storeId } });
  // Pin the control: publishing during the test must not change variant A.
  const control = await db.layoutVersion.create({
    data: {
      storeId,
      label: `Contrôle A — ${new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" })}`,
      theme: (store.theme ?? {}) as Prisma.InputJsonValue,
      checkoutLayout: (store.checkoutLayout ?? { blocks: [] }) as Prisma.InputJsonValue,
      thankYouLayout: (store.thankYouLayout ?? { blocks: [] }) as Prisma.InputJsonValue,
    },
  });
  await db.experiment.updateMany({ where: { storeId, status: "RUNNING" }, data: { status: "STOPPED", endedAt: new Date() } });
  await db.experiment.create({
    data: { storeId, versionId, versionIdA: control.id, splitB: split, autoPromote: fd.get("autoPromote") === "on", name: str(fd, "name").slice(0, 80) || `Test « ${version.label} »` },
  });
  await recordEvent({ storeId, kind: "experiment.started", message: `Test A/B lancé : ${version.label} sur ${split} % du trafic` });
  back(path, { ok: `Test A/B lancé : ${split} % des nouveaux checkouts voient « ${version.label} ».` });
}

export async function stopExperimentAction(storeId: string, experimentId: string, promote: boolean) {
  await getStore(storeId);
  const path = storePath(storeId, "analytics");
  const exp = await db.experiment.findFirst({ where: { id: experimentId, storeId } });
  if (!exp) back(path, { error: "Test introuvable" });
  await db.experiment.update({ where: { id: exp.id }, data: { status: "STOPPED", endedAt: new Date() } });
  if (promote) {
    const v = await db.layoutVersion.findUnique({ where: { id: exp.versionId } });
    if (v) {
      await db.store.update({
        where: { id: storeId },
        data: {
          theme: v.theme as Prisma.InputJsonValue,
          checkoutLayout: v.checkoutLayout as Prisma.InputJsonValue,
          thankYouLayout: v.thankYouLayout as Prisma.InputJsonValue,
          publishedAt: new Date(),
        },
      });
    }
  }
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
  await getStore(storeId);
  const path = storePath(storeId, "shipping");
  const id = str(fd, "id");
  const name = str(fd, "name").slice(0, 80);
  const price = cents(str(fd, "price"));
  if (!name || price == null) back(path, { error: "Nom et prix obligatoires (prix valide, max 1 000 000)" });
  const countries = countriesField(str(fd, "countries"));
  if (!countries) back(path, { error: "Pays : utilisez les codes à 2 lettres séparés par des virgules (ex. FR, BE, CH)" });
  const freeOverRaw = str(fd, "freeOver");
  const freeOver = cents(freeOverRaw);
  if (freeOverRaw && freeOver == null) back(path, { error: "Seuil de livraison gratuite invalide" });
  const data = {
    name,
    deliveryTime: str(fd, "deliveryTime").slice(0, 80) || null,
    countries,
    priceCents: price,
    freeOverCents: freeOver,
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
  if (f.minSubtotal && cents(f.minSubtotal) == null) back(path, { error: "Minimum de commande invalide" });
  const usageLimit = f.usageLimit ? parseInt(f.usageLimit, 10) : null;
  if (usageLimit != null && !(usageLimit >= 1 && usageLimit <= 1_000_000)) {
    back(path, { error: "Limite d'utilisation entre 1 et 1 000 000" });
  }
  // "Expire le 31/12" means usable all day on the 31st (Paris time, the merchant's zone).
  const endsAt = f.endsAt ? endOfDayParis(f.endsAt) : null;
  if (f.endsAt && !endsAt) back(path, { error: "Date d'expiration invalide" });
  const exists = await db.discountCode.findUnique({ where: { storeId_code: { storeId, code: f.code } } });
  if (exists) back(path, { error: `Le code ${f.code} existe déjà` });
  try {
    await db.discountCode.create({
      data: {
        storeId,
        code: f.code,
        type: f.type,
        value,
        minSubtotalCents: cents(f.minSubtotal),
        endsAt,
        usageLimit,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      back(path, { error: `Le code ${f.code} existe déjà` });
    }
    throw err;
  }
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
  // Accepts a bare id, a gid, or a Shopify admin URL (…/variants/456): the last number wins.
  const variantNum = variant.startsWith("gid://") ? null : variant.match(/(\d+)\D*$/)?.[1];
  if (variant && !variant.startsWith("gid://shopify/ProductVariant/") && !variantNum) {
    back(path, { error: "ID de variante invalide : collez le numéro de la variante Shopify" });
  }
  const count = await db.addOn.count({ where: { storeId } });
  await db.addOn.create({
    data: {
      storeId,
      title,
      description: str(fd, "description").slice(0, 200) || null,
      priceCents: price,
      variantId: variant ? (variant.startsWith("gid://") ? variant : `gid://shopify/ProductVariant/${variantNum}`) : null,
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
  const path = storePath(storeId, `orders/${sessionId}`);
  // Manual sync is the merchant's decision on an order held for review.
  await db.checkoutSession.updateMany({ where: { id: sessionId, storeId }, data: { reviewNote: null } });
  try {
    await syncOrder(sessionId);
  } catch (err) {
    back(path, { error: `Échec de la synchronisation : ${errorMessage(err)}` });
  }
  back(path, { ok: "Commande synchronisée dans Shopify" });
}

export async function refundOrderAction(storeId: string, sessionId: string, fd: FormData) {
  const store = await getStore(storeId);
  const path = storePath(storeId, `orders/${sessionId}`);
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId, storeId } });
  if (!session?.whopPaymentId) back(path, { error: "Paiement introuvable" });
  const remaining = session.totalCents - session.refundedCents;
  const raw = str(fd, "amount");
  const amount = raw ? cents(raw) : remaining;
  if (amount == null || amount <= 0 || amount > remaining) back(path, { error: "Montant de remboursement invalide" });
  try {
    await refundPayment(store, session.whopPaymentId, amount === session.totalCents ? undefined : amount);
  } catch (err) {
    back(path, { error: `Whop a refusé le remboursement : ${errorMessage(err)}` });
  }
  // The refund.created webhook records it in Shopify.
  back(path, { ok: "Remboursement demandé à Whop. Il apparaîtra dans Shopify dès confirmation." });
}

/** "2026-12-31" → 2026-12-31T23:59:59.999 Europe/Paris, as a UTC Date. */
function endOfDayParis(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const utc = new Date(`${day}T23:59:59.999Z`);
  if (Number.isNaN(utc.getTime())) return null;
  // Offset of Paris vs UTC on that day (+1h winter, +2h summer).
  const parisHour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23" }).format(
      new Date(`${day}T12:00:00Z`),
    ),
  );
  return new Date(utc.getTime() - (parisHour - 12) * 3600_000);
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
  await db.store.update({
    where: { id: storeId },
    data: {
      metaPixelId,
      metaAccessToken: secretField(fd, "metaAccessToken", store.metaAccessToken, path),
      metaTestEventCode: str(fd, "metaTestEventCode").slice(0, 40) || null,
      tiktokPixelId,
      tiktokAccessToken: secretField(fd, "tiktokAccessToken", store.tiktokAccessToken, path),
      pixelRequireConsent: fd.get("pixelRequireConsent") === "on",
      metaContentIdFormat: str(fd, "metaContentIdFormat") === "shopify" ? "shopify" : "variant",
      metaCatalogCountry: /^[A-Za-z]{2}$/.test(str(fd, "metaCatalogCountry")) ? str(fd, "metaCatalogCountry").toUpperCase() : "FR",
    },
  });
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
  if (alertEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alertEmail)) back(path, { error: "E-mail d'alerte invalide" });
  const emailFrom = str(fd, "emailFrom").slice(0, 200) || null;
  if (emailFrom && !/^([^<>]+<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(emailFrom)) {
    back(path, { error: "Expéditeur invalide : ex. « Alertes <alertes@maboutique.fr> »" });
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
  if (raw && !descriptor) back(path, { error: "Libellé bancaire : il doit contenir au moins une lettre." });
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

export async function savePaymentMethodsAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const methods = fd.getAll("methods").map(String).filter((m) => OPTIONAL_PAYMENT_METHOD_IDS.includes(m));
  await db.store.update({ where: { id: storeId }, data: { paymentMethods: methods } });
  back(storePath(storeId, "whop"), {
    ok: methods.length ? `${methods.length} moyen(s) de paiement ajouté(s) au checkout` : "Moyens de paiement locaux désactivés",
  });
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
  back(path, { ok: "Webhook Whop mis à jour (alertes de fraude incluses)." });
}

function isRedirect(err: unknown) {
  return err instanceof Error && "digest" in err && String((err as { digest?: string }).digest).startsWith("NEXT_REDIRECT");
}

export async function runTickAction(storeId: string) {
  await getStore(storeId);
  const { runTick } = await import("@/lib/tick");
  const report = await runTick();
  back(storePath(storeId, "journal"), {
    ok: `Maintenance terminée : ${Number(report.reconciled) || 0} paiement(s) récupéré(s), ${Number(report.syncRetried) || 0} synchro(s) relancée(s).`,
  });
}
