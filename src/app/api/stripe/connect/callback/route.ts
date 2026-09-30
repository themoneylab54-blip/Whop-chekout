import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { currentUser } from "@/lib/auth";
import { canAccessStore, checkStoreAccess, OWNER_ONLY_ERROR } from "@/lib/access";
import { route } from "@/lib/route";
import { flashUrl, type FlashParams } from "@/lib/flash";
import { log, recordEvent } from "@/lib/log";
import { deauthorize, exchangeCode, registerStripeDomain, retrieveAccount, stripeModeOf, stripeWalletHosts } from "@/lib/stripe";
import { ensureStripeWebhook, saveStripeConnection, stripeConnectionMode } from "@/lib/stripe-connection";
import { peekStripeStateStore, stripeNonceCookie, verifyStripeState } from "@/lib/stripe-state";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/**
 * Stripe Connect OAuth redirect: checks the signed state against this browser's nonce cookie,
 * exchanges the code, saves the connected account on the store, makes sure the platform's Connect
 * webhook exists, registers the checkout hosts for Apple Pay / Google Pay, journals the connection and
 * sends the merchant back to the Stripe page. Admin only, app host only (host-guard).
 */
async function handle(req: Request) {
  const q = new URL(req.url).searchParams;
  const state = q.get("state") ?? "";
  // The store the state names (unverified): picks this store's nonce cookie, and where to send a refusal.
  const claimed = peekStripeStateStore(state);
  const done = (storeId: string | null, params: FlashParams) => {
    const res = NextResponse.redirect(storeId ? `${env.appUrl}${flashUrl(`/dashboard/stores/${storeId}/stripe`, params)}` : `${env.appUrl}/dashboard`);
    if (claimed) res.cookies.set(stripeNonceCookie(claimed), "", { path: "/api/stripe/connect", maxAge: 0 });
    return res;
  };

  const user = await currentUser();
  if (!user) return NextResponse.redirect(`${env.appUrl}/login`);
  const verified = claimed ? verifyStripeState(state, cookieValue(req, stripeNonceCookie(claimed))) : null;
  if (!verified) {
    log.warn("stripe.oauth_bad_state", "Stripe OAuth callback with an invalid, expired or foreign state");
    // Back on that store's page with what to do, only when it is one the user may open (a store outside
    // its scope looks missing: /dashboard); nothing else is trusted from the state.
    const known = claimed ? await db.store.findUnique({ where: { id: claimed }, select: { id: true } }) : null;
    const open = known && (await canAccessStore(user, known.id)) ? known.id : null;
    return done(open, open ? { error: "Lien de connexion Stripe expiré ou ouvert dans un autre onglet : recommencez." } : {});
  }
  // Payment connections are the owner's (checked again: the session may have changed since the start).
  const access = await checkStoreAccess(verified.storeId, "owner");
  if (!access.ok) {
    if (access.reason === "login") return NextResponse.redirect(`${env.appUrl}/login`);
    return done(access.reason === "forbidden" ? verified.storeId : null, access.reason === "forbidden" ? { error: OWNER_ONLY_ERROR } : {});
  }
  const store = access.store;
  const oauthError = q.get("error");
  if (oauthError) {
    return done(store.id, {
      error: oauthError === "access_denied" ? "Connexion Stripe annulée." : `Stripe a refusé la connexion : ${(q.get("error_description") ?? oauthError).slice(0, 200)}`,
    });
  }
  const code = q.get("code");
  if (!code) return done(store.id, { error: "Réponse Stripe invalide : recommencez." });
  const mode = verified.mode;
  if (stripeModeOf(store) !== mode) {
    return done(store.id, { error: "Le mode test / production de la boutique a changé pendant la connexion : recommencez." });
  }

  let token: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    token = await exchangeCode(code, mode);
  } catch (err) {
    log.warn("stripe.oauth_failed", "Stripe OAuth exchange failed", { storeId: store.id, err });
    return done(store.id, { error: `Connexion Stripe impossible : ${errorText(err)}` });
  }
  const livemode = token.livemode;
  // The code is spent and the platform holds the account from here on: an unreadable account (Stripe
  // slow) is saved all the same, nameless and not charging until the Stripe page reads it again.
  let account: Awaited<ReturnType<typeof retrieveAccount>>;
  let accountUnread = false;
  try {
    account = await retrieveAccount(token.accountId, mode);
  } catch (err) {
    log.warn("stripe.account_read_failed", "Stripe account unreadable right after the OAuth exchange: saved without its details", { storeId: store.id, err });
    account = { id: token.accountId, name: null, email: null, country: null, chargesEnabled: false, defaultCurrency: null };
    accountUnread = true;
  }

  // Another account replaces this store's: the platform lets go of the old one (unless another store
  // uses it), with the keys of the mode it was connected in; it stays mapped to the store for its past
  // orders' refunds and disputes (saveStripeConnection).
  const previous = store.stripeAccountId && store.stripeAccountId !== account.id ? store.stripeAccountId : null;
  const previousMode = stripeConnectionMode(store);
  const connected = await saveStripeConnection(store, { id: account.id, name: account.name, livemode, chargesEnabled: account.chargesEnabled }, async () => {
    if (!previous || (await db.store.count({ where: { stripeAccountId: previous } }))) return false;
    return deauthorize(previous, previousMode).then(
      () => true,
      (err) => {
        log.warn("stripe.deauthorize_failed", "Could not release the previous Stripe account", { storeId: store.id, err });
        return false;
      },
    );
  });

  const notes: string[] = [];
  if (await ensureStripeWebhook(store.id, mode)) notes.push("le webhook Stripe n'a pas pu être créé (bouton « Réparer la liaison Stripe » sur cette page)");
  const hosts = stripeWalletHosts(connected);
  const domains: Record<string, string> = {};
  for (const host of hosts) {
    domains[host] = await registerStripeDomain(connected, host).catch((err) => {
      log.warn("stripe.domain_failed", "Could not register a payment method domain on Stripe", { storeId: store.id, host, err });
      return "error";
    });
  }
  if (Object.values(domains).includes("error")) notes.push("Apple Pay : un domaine n'a pas pu être enregistré (réessayez depuis la page Stripe)");
  if (accountUnread) notes.push("Stripe n'a pas renvoyé les détails du compte : il n'encaisse pas tant que cette page ne les a pas relus (rechargez-la dans un instant)");
  else if (!account.chargesEnabled) notes.push("ce compte ne peut pas encore encaisser : terminez son activation dans Stripe");

  const siblings = await db.store.findMany({ where: { stripeAccountId: account.id, id: { not: store.id } }, select: { name: true }, take: 5 });
  await recordEvent({
    storeId: store.id,
    kind: "stripe.connected",
    message: `Compte Stripe « ${account.name ?? account.id} » connecté (${livemode ? "live" : "test"}).${siblings.length ? ` Aussi connecté à ${siblings.map((s) => `« ${s.name} »`).join(", ")}.` : ""}`,
    data: { accountId: account.id, livemode, chargesEnabled: account.chargesEnabled, country: account.country, domains, previous, ...(accountUnread ? { accountUnread: true } : {}) },
  });
  const ok = `Compte Stripe « ${account.name ?? account.id} » connecté.${notes.length ? ` Attention : ${notes.join(" ; ")}.` : ""}`;
  return done(store.id, { ok });
}

export const GET = route("stripe.connect.callback", handle);
