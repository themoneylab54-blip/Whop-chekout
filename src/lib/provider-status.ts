import { DEGRADED_ERROR_RATE } from "./metrics";

/*
 * One status per external provider, shared by the "Services externes" card (Journal) and the
 * sidebar dots of Shopify / Whop, so both always say the same thing. Pure.
 */

export type ProviderLevel = "down" | "degraded" | "watch" | "idle" | "ok";

/** Below this many calls in the hour, 100 % errors is still just "À surveiller". */
export const DOWN_MIN_CALLS = 3;

type Window = { calls: number; errors: number };

export type ProviderStatus = { level: ProviderLevel; label: string; color: "red" | "amber" | "zinc" | "green"; reason: string | null };

const plural = (n: number, word: string) => `${n.toLocaleString("fr-FR")} ${word}${n > 1 ? "s" : ""}`;

/**
 * - En panne (red): every call of the last hour failed (at least 3 calls), or not one success in
 *   24 h although calls were made.
 * - Dégradé (amber): the /api/health rule (more than 20 % errors over ≥ 10 calls, or p95 > 8 s).
 * - À surveiller (amber): more than 20 % errors, but too few calls to call it degraded.
 * - Aucun appel depuis 1 h (grey), else OK (green).
 */
export function providerStatus(p: { hour: (Window & { degraded?: string | null }) | null; day: Window & { lastOkAt: Date | null } }): ProviderStatus {
  const h = p.hour;
  if (h && h.calls >= DOWN_MIN_CALLS && h.errors >= h.calls) {
    return { level: "down", label: "En panne", color: "red", reason: `tous les appels de la dernière heure ont échoué (${plural(h.calls, "appel")})` };
  }
  if (p.day.calls > 0 && !p.day.lastOkAt) {
    return { level: "down", label: "En panne", color: "red", reason: `aucun succès sur 24 h (${plural(p.day.calls, "appel")}, ${plural(p.day.errors, "erreur")})` };
  }
  if (h?.degraded) return { level: "degraded", label: "Dégradé", color: "amber", reason: h.degraded };
  if (!h) return { level: "idle", label: "Aucun appel depuis 1 h", color: "zinc", reason: null };
  if (h.calls > 0 && h.errors / h.calls > DEGRADED_ERROR_RATE) {
    return { level: "watch", label: "À surveiller", color: "amber", reason: `${plural(h.errors, "erreur")} sur ${plural(h.calls, "appel")} dans la dernière heure` };
  }
  return { level: "ok", label: "OK", color: "green", reason: null };
}
