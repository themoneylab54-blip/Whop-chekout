import "server-only";
import { db } from "./db";
import { tickStatus } from "./tick";

export type HealthItem = { key: string; label: string; ok: boolean | null; detail: string; href?: string };

const ago = (d: Date | string | null) => {
  if (!d) return "jamais";
  const min = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `il y a ${h} h` : `il y a ${Math.round(h / 24)} j`;
};

/** Live health checks shown on the overview and the Journal page. */
export async function storeHealth(storeId: string): Promise<HealthItem[]> {
  const base = `/dashboard/stores/${storeId}`;
  const [store, unsynced, holds, lastPaid, tick, failedConversions] = await Promise.all([
    db.store.findUnique({ where: { id: storeId } }),
    db.checkoutSession.count({ where: { storeId, status: "PAID", shopifyOrderId: null, reviewNote: null } }),
    db.checkoutSession.count({ where: { storeId, status: "PAID", shopifyOrderId: null, reviewNote: { not: null } } }),
    db.checkoutSession.findFirst({ where: { storeId, status: "PAID" }, orderBy: { paidAt: "desc" }, select: { paidAt: true } }),
    tickStatus(),
    db.eventLog.count({ where: { storeId, kind: "conversion.failed", createdAt: { gt: new Date(Date.now() - 24 * 3600_000) } } }),
  ]);
  if (!store) return [];
  const tickAge = tick.at ? Date.now() - new Date(tick.at).getTime() : Infinity;
  const items: HealthItem[] = [
    {
      key: "shopify",
      label: "Script Shopify",
      ok: !!store.scriptTagId,
      detail: store.scriptTagId ? "Installé sur la boutique" : "Non installé",
      href: `${base}/shopify`,
    },
    {
      key: "webhook",
      label: "Webhook Whop",
      ok: store.whopConnectedAt ? (lastPaid?.paidAt && store.lastWebhookAt ? store.lastWebhookAt >= lastPaid.paidAt : store.lastWebhookAt != null || !lastPaid) : false,
      detail: store.whopConnectedAt ? `Dernier événement reçu ${ago(store.lastWebhookAt)}` : "Whop non connecté",
      href: `${base}/whop`,
    },
    {
      key: "sync",
      label: "Commandes vers Shopify",
      ok: unsynced === 0,
      detail: unsynced === 0 ? "Toutes synchronisées" : `${unsynced} en attente (nouvel essai automatique)`,
      href: `${base}/orders`,
    },
    {
      key: "review",
      label: "Paiements à vérifier",
      ok: holds === 0,
      detail: holds === 0 ? "Aucun" : `${holds} paiement(s) mis de côté`,
      href: `${base}/orders`,
    },
    {
      key: "tick",
      label: "Maintenance automatique",
      ok: tickAge < 26 * 3600_000 ? true : tick.at ? false : null,
      detail: tick.at ? `Dernier passage ${ago(tick.at)}` : "Pas encore exécutée",
      href: `${base}/journal`,
    },
    {
      key: "pixels",
      label: "Pixels publicitaires",
      ok: store.metaPixelId || store.tiktokPixelId ? failedConversions === 0 : null,
      detail:
        store.metaPixelId || store.tiktokPixelId
          ? failedConversions === 0
            ? [store.metaPixelId && "Meta", store.tiktokPixelId && "TikTok"].filter(Boolean).join(" + ") + " actifs"
            : `${failedConversions} envoi(s) en échec sur 24 h`
          : "Non configurés",
      href: `${base}/growth`,
    },
    {
      key: "alerts",
      label: "Alertes",
      ok: store.alertEmail || store.telegramChatId ? true : null,
      detail: [store.telegramChatId && "Telegram", store.alertEmail && "e-mail"].filter(Boolean).join(" + ") || "Aucun canal configuré",
      href: `${base}/settings`,
    },
  ];
  return items;
}
