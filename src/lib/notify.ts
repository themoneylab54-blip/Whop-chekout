import "server-only";
import type { Store } from "@prisma/client";
import { db } from "./db";
import { decrypt } from "./crypto";
import { env } from "./env";

const TIMEOUT_MS = 8000;

async function post(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
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
  for (const r of results) if (r.status === "rejected") throw r.reason;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
