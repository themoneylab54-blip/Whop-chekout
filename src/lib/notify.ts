import "server-only";
import { extFetch } from "./ext";
import type { Store } from "@prisma/client";
import { db } from "./db";
import { decrypt } from "./crypto";
import { env } from "./env";

const TIMEOUT_MS = 8000;

async function post(url: string, init: RequestInit): Promise<Response> {
  const telegram = url.includes("api.telegram.org");
  return extFetch(telegram ? "telegram" : "resend", telegram ? "sendMessage" : "emails", url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
}

/** Sends a transactional e-mail through the store's Resend account. Returns false when not configured. */
export async function sendEmail(
  store: Pick<Store, "resendApiKey" | "emailFrom" | "name">,
  mail: { to: string; subject: string; html: string; text?: string },
): Promise<boolean> {
  if (!store.resendApiKey || !store.emailFrom) return false;
  const res = await post("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${decrypt(store.resendApiKey)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: store.emailFrom, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

/*
 * Operator-level Resend account: one key for every store of the operator, used for buyer e-mails
 * (returning-buyer codes, claim decisions) when a store has no Resend key of its own. From the
 * environment (OPERATOR_RESEND_API_KEY + OPERATOR_EMAIL_FROM) or the app settings
 * ("operator.resend_api_key" encrypted, "operator.email_from"), the environment first.
 */
export const OPERATOR_KEY_SETTING = "operator.resend_api_key";
export const OPERATOR_FROM_SETTING = "operator.email_from";

export type Mailer = { apiKey: string; from: string; source: "env" | "settings" };

export async function operatorMailer(): Promise<Mailer | null> {
  const envKey = process.env.OPERATOR_RESEND_API_KEY?.trim();
  const envFrom = process.env.OPERATOR_EMAIL_FROM?.trim();
  if (envKey && envFrom) return { apiKey: envKey, from: envFrom, source: "env" };
  const rows = await db.appSetting.findMany({ where: { key: { in: [OPERATOR_KEY_SETTING, OPERATOR_FROM_SETTING] } } });
  const key = rows.find((r) => r.key === OPERATOR_KEY_SETTING)?.value;
  const from = rows.find((r) => r.key === OPERATOR_FROM_SETTING)?.value;
  if (!key || !from) return null;
  try {
    return { apiKey: decrypt(key), from, source: "settings" };
  } catch {
    return null;
  }
}

/** A sender address shown with the store's name ("Ma boutique <noreply@operator.fr>"). Pure. */
export function senderAs(from: string, storeName: string): string {
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from.trim();
  const name = storeName.replace(/["<>\r\n]/g, "").trim().slice(0, 60);
  return name ? `${name} <${address}>` : address;
}

/** Whether buyer e-mails can go out for a store (its own Resend account, else the operator's). */
export async function buyerEmailAvailable(store: Pick<Store, "resendApiKey" | "emailFrom">): Promise<boolean> {
  return !!(store.resendApiKey && store.emailFrom) || !!(await operatorMailer());
}

/**
 * E-mail to a buyer: through the store's Resend account, else the operator's (sent in the store's
 * name). Returns false when neither is configured.
 */
export async function sendBuyerEmail(
  store: Pick<Store, "resendApiKey" | "emailFrom" | "name">,
  mail: { to: string; subject: string; html: string; text?: string },
): Promise<boolean> {
  if (store.resendApiKey && store.emailFrom) return sendEmail(store, mail);
  const op = await operatorMailer();
  if (!op) return false;
  const res = await post("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${op.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: senderAs(op.from, store.name), to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

export async function sendTelegram(store: Pick<Store, "telegramBotToken" | "telegramChatId">, text: string): Promise<boolean> {
  if (!store.telegramBotToken || !store.telegramChatId) return false;
  const res = await post(`https://api.telegram.org/bot${decrypt(store.telegramBotToken)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: store.telegramChatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

/** Merchant alert on every configured channel (Telegram and/or e-mail). */
export async function sendAlert(storeId: string, message: string, sessionId: string | null) {
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store) return;
  const link = `${env.appUrl}/dashboard/stores/${store.id}/orders${sessionId ? `?q=${sessionId}` : ""}`;
  const text = `⚠️ ${store.name} — ${message}\n${link}`;
  const channels = ["telegram", "email"] as const;
  const results = await Promise.allSettled([
    sendTelegram(store, text),
    store.alertEmail
      ? sendEmail(store, {
          to: store.alertEmail,
          subject: `[${store.name}] ${message.slice(0, 90)}`,
          text,
          html: `<p><strong>${escapeHtml(store.name)}</strong></p><p>${escapeHtml(message)}</p><p><a href="${link}">Ouvrir le dashboard</a></p>`,
        })
      : Promise.resolve(false),
  ]);
  const delivered = channels.filter((_, i) => results[i].status === "fulfilled" && (results[i] as PromiseFulfilledResult<boolean>).value);
  const failed = channels.flatMap((c, i) => (results[i].status === "rejected" ? [{ channel: c, reason: (results[i] as PromiseRejectedResult).reason }] : []));
  // One channel is enough: throwing would free the throttle slot and re-send on the working one.
  if (failed.length && !delivered.length) throw failed[0].reason;
  return { delivered: [...delivered], failed: failed.map((f) => f.channel) };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
