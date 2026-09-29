import "server-only";
import { Prisma, type CheckoutSession, type Store } from "@prisma/client";
import { db } from "./db";
import { log, recordEvent } from "./log";
import { recordCheckoutEnabled } from "./fallback";
import { rateLimit } from "./ratelimit";
import { ensureConnectWebhook, probePlatformKeys, retrieveAccount } from "./stripe";
import { stripeConfigured, stripeModeOf, type StripeMode } from "./stripe-config";

/* ------------------------------------------------------------------ */
/* Which account a payment lives on                                    */
/* ------------------------------------------------------------------ */

/**
 * The connected account a session's Stripe payment lives on: the one recorded when its PaymentIntent
 * was created (CheckoutSession.stripeAccountId), else the store's current one (sessions paid before
 * that column existed). Refunds, disputes and reconciliation use it, so a disconnect or a replaced
 * account never sends them to the wrong account. Pure.
 */
export function sessionStripeAccount(session: { stripeAccountId?: CheckoutSession["stripeAccountId"] }, store: Pick<Store, "stripeAccountId">): string | null {
  return session.stripeAccountId || store.stripeAccountId || null;
}

/** How long a store keeps receiving the events of an account it let go of (refunds, disputes of its past orders). */
export const PAST_ACCOUNT_DAYS = 120;
const PAST_PREFIX = "stripe:past-accounts:";
const pastKey = (storeId: string) => `${PAST_PREFIX}${storeId}`;

/** An account the store was connected to: until when its events still map to the store; revoked = the platform's access was removed. */
export type PastStripeAccount = { id: string; until: string; revoked: boolean };

/** The unexpired entries of a `stripe:past-accounts:<store>` value (malformed → none). Pure. */
export function parsePastAccounts(value: string | null | undefined, now = Date.now()): PastStripeAccount[] {
  if (!value) return [];
  try {
    const list = JSON.parse(value) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (a): a is PastStripeAccount =>
        !!a && typeof a === "object" && typeof (a as PastStripeAccount).id === "string" && typeof (a as PastStripeAccount).until === "string" && new Date((a as PastStripeAccount).until).getTime() > now,
    );
  } catch {
    return [];
  }
}

export async function pastStripeAccounts(storeId: string): Promise<PastStripeAccount[]> {
  const row = await db.appSetting.findUnique({ where: { key: pastKey(storeId) } });
  return parsePastAccounts(row?.value);
}

/**
 * Read-modify-write of a store's past-accounts list, optimistic: the write only lands if the row is
 * still the one read (compare-and-set on its value; a create races on the key), else it is re-read and
 * `change` applied again — two concurrent changes (a disconnect and a deauthorization webhook, a
 * reconnection) never drop each other's entry. `change` returns null for "nothing to change".
 */
async function updatePastAccounts(storeId: string, change: (list: PastStripeAccount[]) => PastStripeAccount[] | null): Promise<void> {
  const key = pastKey(storeId);
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await db.appSetting.findUnique({ where: { key } });
    const next = change(parsePastAccounts(row?.value));
    if (!next) return;
    const value = JSON.stringify(next.slice(-10));
    if (!row) {
      if (!next.length) return;
      try {
        await db.appSetting.create({ data: { key, value } });
        return;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue; // created meanwhile: re-read
        throw err;
      }
    }
    const res = next.length
      ? await db.appSetting.updateMany({ where: { key, value: row.value }, data: { value } })
      : await db.appSetting.deleteMany({ where: { key, value: row.value } });
    if (res.count) return;
    // Changed meanwhile: re-read and apply again.
  }
  throw new Error(`liste des anciens comptes Stripe de la boutique ${storeId} modifiée en continu : non enregistrée`);
}

/** Keeps an account the store lets go of (disconnect, replaced, revoked) mapped to it for PAST_ACCOUNT_DAYS. */
export async function rememberPastStripeAccount(storeId: string, accountId: string, revoked: boolean): Promise<void> {
  const until = new Date(Date.now() + PAST_ACCOUNT_DAYS * 86_400_000).toISOString();
  await updatePastAccounts(storeId, (list) => [...list.filter((a) => a.id !== accountId), { id: accountId, until, revoked }]);
}

/** A past account whose access Stripe then revoked: still mapped (late events), no longer read by the reconciliation. */
export async function markPastStripeAccountRevoked(storeId: string, accountId: string): Promise<void> {
  await updatePastAccounts(storeId, (list) => {
    const entry = list.find((a) => a.id === accountId);
    if (!entry || entry.revoked) return null;
    return list.map((a) => (a.id === accountId ? { ...a, revoked: true } : a));
  });
}

/** The account is connected again (same store): no longer a past one. */
async function forgetPastStripeAccount(storeId: string, accountId: string): Promise<void> {
  await updatePastAccounts(storeId, (list) => (list.some((a) => a.id === accountId) ? list.filter((a) => a.id !== accountId) : null));
}

/**
 * Stores an account's events belong to: those connected to it now, then those that let it go less
 * than PAST_ACCOUNT_DAYS ago (their past orders' refunds and disputes still arrive there).
 */
export async function storesForStripeAccount(accountId: string): Promise<{ current: Store[]; past: Store[] }> {
  const current = await db.store.findMany({ where: { stripeAccountId: accountId } });
  const rows = await db.appSetting.findMany({ where: { key: { startsWith: PAST_PREFIX }, value: { contains: JSON.stringify(accountId) } } });
  const ids = rows
    .filter((r) => parsePastAccounts(r.value).some((a) => a.id === accountId))
    .map((r) => r.key.slice(PAST_PREFIX.length))
    .filter((id) => !current.some((s) => s.id === id));
  const past = ids.length ? await db.store.findMany({ where: { id: { in: ids } } }) : [];
  return { current, past };
}

/* ------------------------------------------------------------------ */
/* Connection lifecycle                                                */
/* ------------------------------------------------------------------ */

/**
 * The mode the store's account was connected in (its OAuth token's livemode), for calls about the
 * connection itself (deauthorize): a live connection is released with the live keys even after the
 * store switched to test mode. Unknown, or those keys missing: the store's mode. Pure (env passed in).
 */
export function stripeConnectionMode(store: Pick<Store, "testMode" | "stripeLivemode">, source: Record<string, string | undefined> = process.env): StripeMode {
  const recorded: StripeMode | null = store.stripeLivemode === true ? "live" : store.stripeLivemode === false ? "test" : null;
  return recorded && stripeConfigured(recorded, source) ? recorded : stripeModeOf(store);
}

/** Saves a (re)connection: the account, its mode and whether it can charge; the previous account becomes a past one. */
export async function saveStripeConnection(
  store: Pick<Store, "id" | "stripeAccountId">,
  account: { id: string; name: string | null; livemode: boolean; chargesEnabled: boolean },
  previousRevoked: () => Promise<boolean>,
): Promise<Store> {
  const previous = store.stripeAccountId && store.stripeAccountId !== account.id ? store.stripeAccountId : null;
  const connected = await db.store.update({
    where: { id: store.id },
    data: {
      stripeAccountId: account.id,
      stripeAccountName: account.name,
      stripeLivemode: account.livemode,
      stripeConnectedAt: new Date(),
      stripeChargesEnabled: account.chargesEnabled,
      // Another account: the previous one's last webhook says nothing about this one's (health line).
      ...(store.stripeAccountId !== account.id ? { lastStripeWebhookAt: null } : {}),
    },
  });
  await forgetPastStripeAccount(store.id, account.id);
  if (previous) await rememberPastStripeAccount(store.id, previous, await previousRevoked());
  return connected;
}

/**
 * Forgets the store's Stripe account (merchant's « Déconnecter », or Stripe's
 * account.application.deauthorized): the account fields are cleared, a Stripe-first / Stripe-only
 * mode goes back to « Whop principal », a store-level failover to Stripe is dropped, and a store left
 * without any processor stops intercepting checkouts (buyers keep Shopify's own). The account stays
 * mapped to the store for PAST_ACCOUNT_DAYS (late refunds / disputes of its orders). Journaled.
 */
export async function forgetStripeAccount(
  store: Pick<Store, "id" | "enabled" | "paymentMode" | "stripeAccountId" | "stripeAccountName" | "whopConnectedAt"> & Partial<Pick<Store, "stripeConnectedAt">>,
  how: { by: "merchant" | "stripe"; message: string; revoked?: boolean },
): Promise<boolean> {
  const noProcessorLeft = !store.whopConnectedAt;
  // Conditional on the connection being forgotten still being the store's (same account, and same
  // connection time when known): a reconnection that raced this call — another account, or the same
  // account connected again — is left alone, and two concurrent forgets journal once.
  const res = await db.store.updateMany({
    where: { id: store.id, stripeAccountId: store.stripeAccountId, ...(store.stripeConnectedAt !== undefined ? { stripeConnectedAt: store.stripeConnectedAt } : {}) },
    data: {
      stripeAccountId: null,
      stripeAccountName: null,
      stripeLivemode: null,
      stripeConnectedAt: null,
      stripeChargesEnabled: null,
      lastStripeWebhookAt: null,
      paymentMode: "whop_primary",
      providerFailoverAt: null,
      providerFailoverReason: null,
      ...(noProcessorLeft ? { enabled: false } : {}),
    },
  });
  if (!res.count) return false;
  if (store.stripeAccountId) await rememberPastStripeAccount(store.id, store.stripeAccountId, how.revoked ?? how.by === "stripe");
  if (noProcessorLeft) await recordCheckoutEnabled(store.id, store.enabled, false, "Stripe déconnecté");
  const modeReset = store.paymentMode !== "whop_primary" ? " Le mode de paiement repasse à « Whop principal »." : "";
  await recordEvent({
    storeId: store.id,
    level: how.by === "stripe" ? "error" : "info",
    kind: how.by === "stripe" ? "stripe.deauthorized" : "stripe.disconnected",
    message: `${how.message}${modeReset}${noProcessorLeft && store.enabled ? " Aucun moyen d'encaisser : le checkout est désactivé (vos clients passent par Shopify)." : ""}`,
    data: { accountId: store.stripeAccountId, accountName: store.stripeAccountName, previousMode: store.paymentMode },
    alert: how.by === "stripe",
  });
  return true;
}

const httpStatus = (err: unknown) => (err as { statusCode?: unknown } | null)?.statusCode;

/**
 * After an authentication / permission failure on the store's current account (reconciliation):
 * is the platform's access to it gone (app removed in Stripe without the deauthorization webhook
 * reaching us)? The platform's own keys are checked first (a 401 there means the server keys are
 * wrong, not a revocation), then the account is read: 401 / 403 → the store forgets it like on
 * account.application.deauthorized (journaled, alerted). Anything else (timeout, 5xx, account
 * readable) leaves the connection. Returns whether the account was forgotten.
 */
export async function detectRevokedStripeAccount(store: Store): Promise<boolean> {
  if (!store.stripeAccountId) return false;
  const mode = stripeConnectionMode(store);
  const call = { timeout: 8_000, maxNetworkRetries: 1 };
  try {
    await probePlatformKeys(mode, call);
  } catch {
    return false;
  }
  try {
    await retrieveAccount(store.stripeAccountId, mode, call);
    return false;
  } catch (err) {
    const status = httpStatus(err);
    if (status !== 401 && status !== 403) return false;
    log.warn("stripe.access_revoked", "Stripe refuses access to the store's connected account: forgotten", { storeId: store.id, status });
    await forgetStripeAccount(store, {
      by: "stripe",
      message: `Stripe refuse l'accès au compte « ${store.stripeAccountName ?? store.stripeAccountId} » (${status}) : l'application a été retirée de ce compte Stripe. Stripe est déconnecté de la boutique ; reconnectez-le depuis la page Stripe pour l'utiliser de nouveau.`,
      revoked: true,
    });
    return true;
  }
}

/** A Stripe payment in flight counts this long after its last change (older PAYING rows are stale). */
const PAYING_RECENT_MS = 2 * 3600_000;
/** A Stripe-paid session this recent without its Shopify order is still being finished. */
const PAID_RECENT_MS = 30 * 60_000;

/** What a « Déconnecter » now would cut short: Stripe payments in flight, recent Stripe payments without their order. */
export async function stripeDisconnectBlockers(storeId: string, now = Date.now()): Promise<{ paying: number; unsynced: number }> {
  const [paying, unsynced] = await Promise.all([
    db.checkoutSession.count({ where: { storeId, paymentProvider: "stripe", status: "PAYING", updatedAt: { gte: new Date(now - PAYING_RECENT_MS) } } }),
    db.checkoutSession.count({ where: { storeId, paymentProvider: "stripe", status: "PAID", shopifyOrderId: null, paidAt: { gte: new Date(now - PAID_RECENT_MS) } } }),
  ]);
  return { paying, unsynced };
}

/** The refusal of a disconnect with blockers, in French (null: nothing in flight). Pure. */
export function disconnectBlockMessage(b: { paying: number; unsynced: number }): string | null {
  const parts: string[] = [];
  if (b.paying) parts.push(`${b.paying} paiement${b.paying > 1 ? "s" : ""} Stripe en cours`);
  if (b.unsynced) parts.push(`${b.unsynced} paiement${b.unsynced > 1 ? "s" : ""} Stripe des 30 dernières minutes sans commande Shopify`);
  if (!parts.length) return null;
  return `Déconnexion refusée : ${parts.join(" et ")}. Attendez quelques minutes que ces paiements aboutissent, ou cochez « Déconnecter quand même » (ils pourraient ne jamais être enregistrés).`;
}

/**
 * Records whether the connected account can take payments (Stripe's charges_enabled): at connection,
 * on the Stripe page, on account.updated. A change is written once (conditional update: two
 * deliveries don't journal twice) and journaled — loudly when payments were turned off. Returns
 * whether it changed.
 */
export async function applyChargesEnabled(
  store: Pick<Store, "id" | "stripeAccountId" | "stripeAccountName" | "stripeChargesEnabled">,
  enabled: boolean,
  source: "webhook" | "page",
): Promise<boolean> {
  if (!store.stripeAccountId || store.stripeChargesEnabled === enabled) return false;
  const res = await db.store.updateMany({
    where: { id: store.id, stripeAccountId: store.stripeAccountId, OR: [{ stripeChargesEnabled: null }, { stripeChargesEnabled: !enabled }] },
    data: { stripeChargesEnabled: enabled },
  });
  if (!res.count) return false;
  const name = store.stripeAccountName ?? store.stripeAccountId;
  // Unknown → enabled (first read after the upgrade): nothing to tell.
  if (enabled && store.stripeChargesEnabled == null) return true;
  await recordEvent({
    storeId: store.id,
    level: enabled ? "info" : "error",
    kind: enabled ? "stripe.charges_enabled" : "stripe.charges_disabled",
    message: enabled
      ? `Le compte Stripe « ${name} » peut de nouveau encaisser : Stripe est réutilisé.`
      : `Stripe a désactivé les paiements du compte « ${name} » (activation incomplète ou compte restreint) : Stripe n'encaisse plus, ni en secours. Terminez les étapes demandées dans votre dashboard Stripe.`,
    data: { accountId: store.stripeAccountId, source },
    alert: !enabled,
  });
  return true;
}

/**
 * ensureConnectWebhook for a store's action (connection, « Réparer la liaison Stripe », « Tester le
 * secours », domains): null when the endpoint is in place, else the error (journaled
 * `stripe.webhook_setup_failed`, alerted; `lazy` calls journal at most every 30 minutes).
 */
export async function ensureStripeWebhook(storeId: string, mode: StripeMode, opts: { lazy?: boolean } = {}): Promise<string | null> {
  try {
    await ensureConnectWebhook(mode);
    return null;
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    log.warn("stripe.webhook_setup_failed", "Stripe Connect webhook could not be set up", { storeId, mode, err });
    if (!opts.lazy || (await rateLimit(`stripe-webhook-setup:${storeId}`, 1, 30 * 60_000))) {
      await recordEvent({
        storeId,
        level: "error",
        kind: "stripe.webhook_setup_failed",
        message: `Webhook Stripe non créé ou non vérifié (${message}) : les paiements Stripe ne sont confirmés que par la vérification périodique. Utilisez « Réparer la liaison Stripe » sur la page Stripe.`,
        data: { mode },
        alert: true,
        err,
      });
    }
    return message;
  }
}
