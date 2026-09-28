import "server-only";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { CheckoutSession, Store } from "@prisma/client";
import { db } from "./db";
import { env } from "./env";
import { escapeHtml, sendEmail, operatorMailer, sendBuyerEmail } from "./notify";
import { recordIncident } from "./incidents";
import { rateLimit } from "./ratelimit";
import type { Address } from "./shopify";

/*
 * "Déjà client ? Recevez un code par e-mail" (Store.returningBuyerCode): a buyer on a new device
 * gets a 6-digit one-time code by e-mail; the right code fills the contact and shipping address of
 * their last paid order on this store.
 *
 * Privacy: the answer to "send me a code" never says whether the e-mail has an order (a code is
 * only sent when it does); nothing about the buyer leaves the server before the code is verified,
 * and the verified data only fills the checkout that asked for it. Codes are stored as an HMAC
 * (never in clear), expire after 10 minutes, allow 5 tries, and one code per checkout is live
 * at a time. Sending is rate-limited by the route (IP, checkout, e-mail).
 */

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;

type Lang = "fr" | "en" | "de" | "es" | "it" | "nl";

const MAIL: Record<Lang, { subject: (shop: string) => string; body: (code: string, shop: string) => string }> = {
  fr: { subject: (s) => `Votre code de connexion ${s}`, body: (c, s) => `Votre code pour retrouver vos coordonnées sur ${s} : ${c}. Il est valable 10 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.` },
  en: { subject: (s) => `Your ${s} sign-in code`, body: (c, s) => `Your code to retrieve your details on ${s}: ${c}. It is valid for 10 minutes. If you didn't ask for it, ignore this e-mail.` },
  de: { subject: (s) => `Ihr Anmeldecode für ${s}`, body: (c, s) => `Ihr Code, um Ihre Daten bei ${s} abzurufen: ${c}. Er ist 10 Minuten gültig. Wenn Sie ihn nicht angefordert haben, ignorieren Sie diese E-Mail.` },
  es: { subject: (s) => `Tu código de acceso a ${s}`, body: (c, s) => `Tu código para recuperar tus datos en ${s}: ${c}. Es válido durante 10 minutos. Si no lo has solicitado, ignora este correo.` },
  it: { subject: (s) => `Il tuo codice di accesso a ${s}`, body: (c, s) => `Il tuo codice per recuperare i tuoi dati su ${s}: ${c}. È valido 10 minuti. Se non l'hai richiesto, ignora questa e-mail.` },
  nl: { subject: (s) => `Je inlogcode voor ${s}`, body: (c, s) => `Je code om je gegevens bij ${s} op te halen: ${c}. Hij is 10 minuten geldig. Heb je hem niet aangevraagd, negeer deze e-mail dan.` },
};

export const normalEmail = (e: string) => e.trim().toLowerCase();

/** HMAC of a code, bound to the checkout and the e-mail (a code can't be replayed elsewhere). Pure. */
export function hashLoginCode(sessionId: string, email: string, code: string, secret = env.sessionSecret): string {
  return createHmac("sha256", secret).update(`${sessionId}\n${normalEmail(email)}\n${code}`).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The buyer's last paid order (the source of the filled details), or null: on this store, or —
 * when the store is in the operator's "réseau de boutiques" (Store.storeNetwork) — on any store of
 * the network (every store that opted in). Stores outside the network are never searched.
 */
async function lastPaidOrder(storeId: string, email: string) {
  const store = await db.store.findUnique({ where: { id: storeId }, select: { storeNetwork: true } });
  return db.checkoutSession.findFirst({
    where: {
      status: "PAID",
      email: { equals: normalEmail(email), mode: "insensitive" },
      ...(store?.storeNetwork ? { OR: [{ storeId }, { store: { storeNetwork: true } }] } : { storeId }),
    },
    orderBy: { paidAt: "desc" },
    select: { email: true, shippingAddress: true, acceptsMarketing: true },
  });
}

export type SendResult = "sent" | "disabled";

/**
 * Whether the store sends codes (decided before any lookup: the answer never depends on the e-mail).
 * `operatorMail`: the operator-level Resend account is configured (it sends for stores without their own).
 */
export function loginCodeAvailable(store: Pick<Store, "returningBuyerCode" | "resendApiKey" | "emailFrom">, operatorMail = false): boolean {
  return store.returningBuyerCode && ((!!store.resendApiKey && !!store.emailFrom) || operatorMail);
}

/** loginCodeAvailable with the operator's Resend account looked up. */
export async function loginCodeEnabled(store: Pick<Store, "returningBuyerCode" | "resendApiKey" | "emailFrom">): Promise<boolean> {
  if (!store.returningBuyerCode) return false;
  return loginCodeAvailable(store) || !!(await operatorMailer());
}

/** Failed code checks allowed per day, per e-mail on a store and per checkout (then every code is refused). */
export const MAX_FAILED_VERIFY_PER_DAY = 10;
const DAY_MS = 24 * 3600_000;
const failKeys = (storeId: string, sessionId: string, email: string) => [`otpfail:e:${storeId}:${normalEmail(email)}`, `otpfail:s:${sessionId}`];

/** Over the daily budget of failed checks (e-mail or checkout): nothing is sent or verified. */
async function overFailureCap(storeId: string, sessionId: string, email: string): Promise<boolean> {
  const rows = await db.rateLimit.findMany({ where: { key: { in: failKeys(storeId, sessionId, email) }, resetAt: { gt: new Date() } }, select: { count: true } });
  return rows.some((r) => r.count >= MAX_FAILED_VERIFY_PER_DAY);
}

async function countFailure(storeId: string, sessionId: string, email: string) {
  for (const key of failKeys(storeId, sessionId, email)) await rateLimit(key, Number.MAX_SAFE_INTEGER, DAY_MS);
}

/**
 * Sends a code when the e-mail has a paid order on this store. Always "sent" when the feature is
 * on (whether or not an e-mail went out), "disabled" otherwise. The route answers first and runs
 * deliverLoginCode after the response (its timing must not reveal whether the e-mail is a customer).
 */
export async function requestLoginCode(session: CheckoutSession & { store: Store }, email: string): Promise<SendResult> {
  if (!(await loginCodeEnabled(session.store))) return "disabled";
  await deliverLoginCode(session, email);
  return "sent";
}

/** The lookup, the code and the e-mail (after the response). Never throws. */
export async function deliverLoginCode(session: CheckoutSession & { store: Store }, email: string): Promise<void> {
  const store = session.store;
  const to = normalEmail(email);
  if (await overFailureCap(store.id, session.id, to)) return;
  const order = await lastPaidOrder(store.id, to);
  if (!order?.shippingAddress) return;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.$transaction([
    // One live code per checkout (a new request replaces it), and old codes of the store go.
    db.buyerLoginCode.deleteMany({ where: { OR: [{ sessionId: session.id, usedAt: null }, { storeId: store.id, expiresAt: { lt: new Date(Date.now() - 3600_000) } }] } }),
    db.buyerLoginCode.create({
      data: { storeId: store.id, sessionId: session.id, email: to, codeHash: hashLoginCode(session.id, to, code), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
    }),
  ]);
  const lang = (["fr", "en", "de", "es", "it", "nl"].includes(session.lang ?? "") ? session.lang : "fr") as Lang;
  const text = MAIL[lang].body(code, store.name);
  try {
    const mail = {
      to,
      subject: MAIL[lang].subject(store.name),
      text,
      html: `<p>${escapeHtml(text).replace(code, `<strong style="font-size:20px;letter-spacing:3px">${code}</strong>`)}</p>`,
    };
    // The store's own Resend account, else the operator's (one key for every store).
    await (store.resendApiKey && store.emailFrom ? sendEmail(store, mail) : sendBuyerEmail(store, mail));
  } catch (err) {
    await recordIncident({
      storeId: store.id,
      sessionId: session.id,
      kind: "returning.email_failed",
      message: `Code de connexion « Déjà client ? » non envoyé : ${err instanceof Error ? err.message.slice(0, 200) : String(err)}. Vérifiez la clé Resend et l'expéditeur.`,
      data: { err: err instanceof Error ? err.message : String(err) },
    });
  }
}

export type VerifiedBuyer = { email: string; address: Address; acceptsMarketing: boolean };

/**
 * Checks a code for this checkout and e-mail. Right code (live, under 5 tries): marks it used
 * and returns the details of the last paid order; anything else: null (and a try is counted).
 */
export async function verifyLoginCode(session: Pick<CheckoutSession, "id" | "storeId">, email: string, code: string): Promise<VerifiedBuyer | null> {
  const to = normalEmail(email);
  if (!/^\d{6}$/.test(code)) return null;
  // Daily cap on wrong codes per e-mail and per checkout (5 tries per code × new codes otherwise).
  if (await overFailureCap(session.storeId, session.id, to)) return null;
  const row = await db.buyerLoginCode.findFirst({ where: { sessionId: session.id, email: to, usedAt: null }, orderBy: { createdAt: "desc" } });
  if (!row || row.expiresAt.getTime() < Date.now() || row.attempts >= MAX_CODE_ATTEMPTS) return null;
  // Count the try first (atomically, bounded): parallel guesses can't exceed the budget.
  const counted = await db.buyerLoginCode.updateMany({ where: { id: row.id, usedAt: null, attempts: { lt: MAX_CODE_ATTEMPTS } }, data: { attempts: { increment: 1 } } });
  if (!counted.count) return null;
  if (!sameHash(row.codeHash, hashLoginCode(session.id, to, code))) {
    await countFailure(session.storeId, session.id, to);
    return null;
  }
  const used = await db.buyerLoginCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (!used.count) return null;
  const order = await lastPaidOrder(session.storeId, to);
  if (!order?.shippingAddress) return null;
  return { email: order.email ?? to, address: order.shippingAddress as unknown as Address, acceptsMarketing: order.acceptsMarketing };
}
