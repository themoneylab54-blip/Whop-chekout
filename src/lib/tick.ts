import "server-only";
import type { CheckoutSession, Store } from "@prisma/client";
import { db } from "./db";
import { env } from "./env";
import { markPaid, syncOrderSafely } from "./checkout";
import { pushTracking } from "./disputes";
import { loadTheme } from "./layout";
import { log, recordEvent } from "./log";
import { escapeHtml, sendEmail } from "./notify";
import { formatMoney, type CartLine } from "./pricing";
import { paymentInfoFromWhop, storeClient } from "./whop";

/*
 * Background maintenance, run by Vercel Cron and opportunistically by live traffic
 * (at most every few minutes). Every job is idempotent and bounded, so overlapping
 * runs are harmless.
 *
 *  1. reconcile  — pull recent paid Whop payments and heal any missed webhook
 *  2. retries    — re-run failed Shopify syncs whose backoff has elapsed
 *  3. recovery   — abandoned checkout e-mails (1 h, then 24 h)
 *  4. tracking   — push Shopify tracking numbers to Whop (dispute shield)
 *  5. cleanup    — expired rate-limit rows
 */

const TICK_KEY = "tick:last";
const MIN_INTERVAL_MS = 4 * 60 * 1000;

/** Runs the tick if the last one is older than a few minutes (atomic claim). */
export async function maybeTick(): Promise<boolean> {
  const cutoff = new Date(Date.now() - MIN_INTERVAL_MS).toISOString();
  const now = new Date().toISOString();
  const claimed = await db.$executeRaw`
    INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES (${TICK_KEY}, ${now}, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()
    WHERE "AppSetting"."value" < ${cutoff}`;
  if (claimed === 0) return false;
  await runTick();
  return true;
}

export type TickReport = Record<string, number | string>;

export async function runTick(): Promise<TickReport> {
  const report: TickReport = {};
  const started = Date.now();
  const jobs: [string, () => Promise<number>][] = [
    ["reconciled", reconcilePayments],
    ["syncRetried", retrySyncs],
    ["recoveryEmails", sendRecoveryEmails],
    ["trackingPushed", pushTrackingNumbers],
    ["cleaned", cleanup],
  ];
  for (const [name, job] of jobs) {
    try {
      report[name] = await job();
    } catch (err) {
      report[name] = `error: ${err instanceof Error ? err.message : String(err)}`;
      log.error("tick.job_failed", `Background job ${name} failed`, { err });
    }
  }
  report.ms = Date.now() - started;
  await db.appSetting.upsert({
    where: { key: "tick:report" },
    create: { key: "tick:report", value: JSON.stringify({ at: new Date().toISOString(), ...report }) },
    update: { value: JSON.stringify({ at: new Date().toISOString(), ...report }) },
  });
  log.info("tick.done", "Background tick finished", report);
  return report;
}

/* 1. Reconciliation ---------------------------------------------------------- */

async function reconcilePayments(): Promise<number> {
  const stores = await db.store.findMany({ where: { whopConnectedAt: { not: null }, whopProductId: { not: null } } });
  let healed = 0;
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();
  for (const store of stores) {
    try {
      healed += await reconcileStore(store, since);
    } catch (err) {
      log.warn("reconcile.store_failed", "Whop reconciliation failed for a store", { storeId: store.id, err });
    }
  }
  return healed;
}

async function reconcileStore(store: Store, since: string): Promise<number> {
  const client = storeClient(store);
  let healed = 0;
  let seen = 0;
  const page = await client.payments.list({
    account_id: store.whopAccountId ?? undefined,
    product_id: store.whopProductId ?? undefined,
    status: "paid",
    created_after: since,
    first: 50,
  });
  for await (const p of page) {
    if (++seen > 200) break;
    const data = p as unknown as Record<string, unknown>;
    const metadata = (data.metadata ?? {}) as Record<string, unknown>;
    if (typeof metadata.upsell_id === "string") continue; // handled by the upsell flow
    const sessionId =
      (typeof metadata.checkout_session_id === "string" ? metadata.checkout_session_id : null) ??
      (p.checkout_configuration_id
        ? (await db.checkoutQuote.findUnique({ where: { whopCheckoutId: p.checkout_configuration_id }, select: { sessionId: true } }))?.sessionId
        : null);
    if (!sessionId) continue;
    const session = await db.checkoutSession.findUnique({ where: { id: sessionId }, select: { storeId: true, status: true, whopPaymentId: true } });
    if (!session || session.storeId !== store.id) continue;
    if (session.status === "PAID" && session.whopPaymentId) continue; // already known (or flagged as duplicate)
    await markPaid(sessionId, paymentInfoFromWhop(data));
    healed++;
    await recordEvent({
      storeId: store.id,
      sessionId,
      level: "warn",
      kind: "reconcile.healed",
      message: `Paiement ${p.id} récupéré par la réconciliation (webhook manquant)`,
    });
  }
  return healed;
}

/* 2. Shopify sync retries ---------------------------------------------------- */

async function retrySyncs(): Promise<number> {
  const due = await db.checkoutSession.findMany({
    where: {
      status: "PAID",
      shopifyOrderId: null,
      reviewNote: null,
      OR: [
        { nextSyncAt: { lte: new Date() } },
        // paid but never attempted (e.g. crash between PAID and sync)
        { syncAttempts: 0, paidAt: { lt: new Date(Date.now() - 3 * 60_000) } },
      ],
    },
    select: { id: true },
    take: 20,
    orderBy: { paidAt: "asc" },
  });
  for (const s of due) await syncOrderSafely(s.id);
  return due.length;
}

/* 3. Abandoned checkout recovery -------------------------------------------- */

export const RECOVERY_STEPS_MIN = [60, 24 * 60];

async function sendRecoveryEmails(): Promise<number> {
  const stores = await db.store.findMany({ where: { recoveryEnabled: true, resendApiKey: { not: null }, emailFrom: { not: null } } });
  let sent = 0;
  for (const store of stores) {
    for (let stage = 0; stage < RECOVERY_STEPS_MIN.length; stage++) {
      const olderThan = new Date(Date.now() - RECOVERY_STEPS_MIN[stage] * 60_000);
      const sessions = await db.checkoutSession.findMany({
        where: {
          storeId: store.id,
          status: { in: ["OPEN", "PAYING", "FAILED", "ABANDONED"] },
          email: { not: null },
          recoveryStage: stage,
          updatedAt: { lt: olderThan },
          createdAt: { gt: new Date(Date.now() - 3 * 24 * 3600_000) },
          ...(store.recoveryConsentOnly ? { acceptsMarketing: true } : {}),
        },
        take: 25,
      });
      for (const s of sessions) {
        // Claim the stage first: never send the same e-mail twice.
        const claim = await db.checkoutSession.updateMany({
          where: { id: s.id, recoveryStage: stage },
          data: { recoveryStage: stage + 1, recoverySentAt: new Date(), status: s.status === "OPEN" ? "ABANDONED" : s.status },
        });
        if (claim.count === 0) continue;
        try {
          await sendEmail(store, recoveryEmail(store, s, stage));
          sent++;
          await recordEvent({ storeId: store.id, sessionId: s.id, kind: "recovery.sent", message: `Relance panier n°${stage + 1} envoyée à ${s.email}` });
        } catch (err) {
          log.warn("recovery.send_failed", "Recovery e-mail failed", { sessionId: s.id, err });
        }
      }
    }
  }
  return sent;
}

export function recoveryEmail(store: Store, s: CheckoutSession, stage: number) {
  const theme = loadTheme(store.theme, store.name);
  const brand = theme.storeName || store.name;
  const lines = s.lines as unknown as CartLine[];
  const url = `${env.appUrl}/c/${s.id}?utm_source=recovery&utm_medium=email&utm_campaign=abandon_${stage + 1}`;
  const code = stage === 1 && store.recoveryCode ? store.recoveryCode : null;
  const fr = theme.language === "fr";
  const subject = fr
    ? stage === 0
      ? `Votre panier vous attend chez ${brand}`
      : code
        ? `Un cadeau pour finaliser votre commande`
        : `Dernier rappel : votre panier chez ${brand}`
    : stage === 0
      ? `Your cart is waiting at ${brand}`
      : code
        ? `A gift to complete your order`
        : `Last reminder: your cart at ${brand}`;
  const money = (c: number) => formatMoney(c, s.currency, fr ? "fr-FR" : "en-US");
  const items = lines
    .map(
      (l) => `<tr>
  <td style="padding:8px 0">${l.imageUrl ? `<img src="${escapeHtml(l.imageUrl)}" width="56" height="56" style="border-radius:8px;object-fit:cover" alt="">` : ""}</td>
  <td style="padding:8px 12px;font-size:14px">${escapeHtml(l.title)}${l.variantTitle ? `<br><span style="color:#71717a">${escapeHtml(l.variantTitle)}</span>` : ""} × ${l.quantity}</td>
  <td style="padding:8px 0;text-align:right;font-size:14px">${money(l.unitPriceCents * l.quantity)}</td></tr>`,
    )
    .join("");
  const accent = theme.accentColor;
  const intro = fr
    ? stage === 0
      ? "Vous avez laissé des articles dans votre panier. Ils sont encore disponibles — finalisez votre commande en un clic."
      : "Vos articles sont toujours réservés pour quelques heures."
    : stage === 0
      ? "You left items in your cart. They're still available — complete your order in one click."
      : "Your items are still reserved for a few hours.";
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;padding:32px" cellpadding="0" cellspacing="0">
<tr><td>${theme.logoUrl ? `<img src="${escapeHtml(theme.logoUrl)}" height="36" alt="${escapeHtml(brand)}">` : `<strong style="font-size:18px">${escapeHtml(brand)}</strong>`}</td></tr>
<tr><td style="padding-top:24px"><h1 style="font-size:22px;margin:0 0 8px">${escapeHtml(subject)}</h1><p style="margin:0;color:#52525b;font-size:15px;line-height:1.5">${intro}</p></td></tr>
<tr><td style="padding-top:20px"><table width="100%" cellpadding="0" cellspacing="0">${items}</table></td></tr>
${code ? `<tr><td style="padding-top:16px"><div style="border:2px dashed ${accent};border-radius:12px;padding:14px;text-align:center;font-size:15px">${fr ? "Votre code" : "Your code"} : <strong style="font-size:18px;letter-spacing:.08em">${escapeHtml(code)}</strong></div></td></tr>` : ""}
<tr><td style="padding-top:24px" align="center"><a href="${url}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:600;font-size:15px">${fr ? "Finaliser ma commande" : "Complete my order"}</a></td></tr>
<tr><td style="padding-top:28px;color:#a1a1aa;font-size:12px;line-height:1.5">${fr ? `Vous recevez cet e-mail car vous avez commencé une commande sur ${escapeHtml(brand)}. Si ce n'était pas vous, ignorez-le simplement.` : `You're receiving this because you started an order at ${escapeHtml(brand)}. If this wasn't you, just ignore it.`}</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${subject}\n\n${intro}\n\n${lines.map((l) => `- ${l.title} × ${l.quantity}`).join("\n")}\n${code ? `\nCode : ${code}\n` : ""}\n${url}`;
  return { to: s.email!, subject, html, text };
}

/* 4. Tracking → Whop ---------------------------------------------------------- */

async function pushTrackingNumbers(): Promise<number> {
  const sessions = await db.checkoutSession.findMany({
    where: {
      status: "PAID",
      shopifyOrderId: { not: null },
      whopPaymentId: { not: null },
      trackingPushedAt: null,
      paidAt: { gt: new Date(Date.now() - 45 * 24 * 3600_000) },
      store: { pushTracking: true },
      OR: [{ trackingCheckedAt: null }, { trackingCheckedAt: { lt: new Date(Date.now() - 6 * 3600_000) } }],
    },
    include: { store: true },
    take: 20,
    orderBy: { paidAt: "asc" },
  });
  let pushed = 0;
  for (const s of sessions) {
    try {
      if (await pushTracking(s)) pushed++;
    } catch (err) {
      log.warn("tracking.push_failed", "Could not push tracking to Whop", { sessionId: s.id, err });
    }
  }
  return pushed;
}

/* 5. Cleanup ------------------------------------------------------------------ */

async function cleanup(): Promise<number> {
  const { count } = await db.rateLimit.deleteMany({ where: { resetAt: { lt: new Date(Date.now() - 3600_000) } } });
  return count;
}

/** Health summary for the dashboard. */
export async function tickStatus(): Promise<{ at: string | null; report: TickReport | null }> {
  const row = await db.appSetting.findUnique({ where: { key: "tick:report" } });
  if (!row) return { at: null, report: null };
  try {
    const parsed = JSON.parse(row.value) as TickReport & { at: string };
    return { at: parsed.at, report: parsed };
  } catch {
    return { at: null, report: null };
  }
}
