import "server-only";
import { db } from "./db";
import { log, recordEvent } from "./log";
import { rateLimit } from "./ratelimit";

/*
 * Degradations that don't stop a payment but cost the merchant or the buyer something
 * (a Shopify code refused because the lookup failed, an automatic discount lost because the
 * cart couldn't be re-read, a buyer charged in the shop currency because the ECB rates are
 * missing, a sign-in code e-mail that never left). Each occurrence is logged; the journal gets
 * at most one row per store and kind every 5 minutes (an outage doesn't flood it), alerts are
 * grouped per store and kind by recordEvent, and the health tiles / probe count the rows.
 */

export const INCIDENT_KINDS = {
  "discount.shopify_lookup_failed": "recherche(s) de code promo Shopify en échec",
  "checkout.shopify_failed": "ouverture(s) du paiement bloquée(s) par Shopify (panier impossible à calculer)",
  "discount.cart_read_failed": "relecture(s) du panier Shopify en échec (remises automatiques perdues)",
  "fx.charge_fallback": "paiement(s) facturé(s) dans la devise de la boutique faute de taux BCE",
  "returning.email_failed": "e-mail(s) de code de connexion non envoyé(s)",
  "fx.stale": "taux de change BCE périmés",
  "google.conversions_auth_failed": "connexion(s) Google Ads refusée(s) : conversions hors ligne non envoyées",
  "google.conversions_account_error": "envoi(s) des conversions Google Ads suspendu(s) (erreur du compte)",
  "google.conversion_retrying": "envoi(s) ou ajustement(s) de conversion Google Ads en échec (nouvel essai automatique)",
  "reconcile.whop_slow": "vérification(s) Whop (paiements, remboursements, litiges) reportée(s) : Whop lent ou indisponible",
  "reconcile.stripe_slow": "vérification(s) Stripe (paiements, remboursements, litiges) reportée(s) : Stripe lent ou indisponible",
  "import.background_failed": "import(s) en arrière-plan en échec depuis plus de 48 h (historique clients, commandes hors checkout ou dépenses pub)",
} as const;
export type IncidentKind = keyof typeof INCIDENT_KINDS;

const JOURNAL_EVERY_MS = 5 * 60_000;

/** Logs an incident, journals it (one row per store and kind per 5 min) and alerts (grouped). Never throws. */
export async function recordIncident(e: {
  storeId: string;
  sessionId?: string | null;
  kind: IncidentKind;
  message: string;
  data?: Record<string, unknown>;
  alert?: boolean;
  /** At most one journal row (and alert) per store and kind in this window (default 5 min). */
  everyMs?: number;
  /** The error behind it: in the log line and forwarded to Sentry with the journal row, never in the journal itself. */
  err?: unknown;
}) {
  log.warn(e.kind, e.message, { storeId: e.storeId, sessionId: e.sessionId, ...e.data, ...(e.err !== undefined ? { err: e.err } : {}) });
  try {
    if (!(await rateLimit(`incident:${e.storeId}:${e.kind}`, 1, e.everyMs ?? JOURNAL_EVERY_MS))) return;
    await recordEvent({ storeId: e.storeId, sessionId: e.sessionId ?? null, level: "warn", kind: e.kind, message: e.message, data: e.data, alert: e.alert ?? true, err: e.err });
  } catch (err) {
    log.error("incident.record_failed", "Could not journal an incident", { kind: e.kind, err });
  }
}

/** Journaled incidents of the last `hours` by kind (a row = at least one failure in a 5-min window). */
export async function incidentCounts(storeId?: string, hours = 24): Promise<Partial<Record<IncidentKind, number>>> {
  const rows = await db.eventLog.groupBy({
    by: ["kind"],
    where: { ...(storeId ? { storeId } : {}), kind: { in: Object.keys(INCIDENT_KINDS) }, createdAt: { gt: new Date(Date.now() - hours * 3600_000) } },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.kind, r._count._all])) as Partial<Record<IncidentKind, number>>;
}

/** One line per kind with occurrences, for the health tile and the probe. Pure. */
export function incidentLines(counts: Partial<Record<IncidentKind, number>>, only?: (kind: IncidentKind) => boolean): string[] {
  return (Object.keys(INCIDENT_KINDS) as IncidentKind[]).filter((k) => (counts[k] ?? 0) > 0 && (!only || only(k))).map((k) => `${counts[k]} × ${INCIDENT_KINDS[k]} (24 h)`);
}
