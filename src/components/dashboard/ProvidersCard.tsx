import { PlugZap } from "lucide-react";
import type { ProviderOverview } from "@/lib/providers";
import { providerStatus } from "@/lib/provider-status";
import { Badge, Card } from "@/components/ui";
import { ErrorText } from "@/components/dashboard/ErrorText";
import { formatDateTimeLong, formatWhen } from "@/components/dashboard/dates";

const pct = (errors: number, calls: number) => (calls ? `${(Math.round((1000 * errors) / calls) / 10).toLocaleString("fr-FR")} %` : "—");
const secs = (ms: number | null) => (ms == null ? "—" : ms < 1000 ? `${ms} ms` : `${(Math.round(ms / 100) / 10).toLocaleString("fr-FR")} s`);
const count = (n: number) => n.toLocaleString("fr-FR");

/**
 * "Services externes" (Journal page): each provider called in the last 24 h (Shopify, Whop, ad
 * platforms, ECB, e-mails, Mondial Relay) with its calls, error rate and p95 latency over 1 h and
 * 24 h, its last success and its last error in plain French. Status (providerStatus, also the
 * sidebar dots): En panne = every call of the last hour failed (≥ 3 calls) or no success in 24 h;
 * Dégradé = more than 20 % errors over at least 10 calls, or p95 over 8 s, in the last hour (the
 * same rule as /api/health).
 */
export function ProvidersCard({ providers, tz, now = new Date() }: { providers: ProviderOverview[]; tz: string; now?: Date }) {
  return (
    <Card
      id="services"
      icon={PlugZap}
      iconColor="#8b5cf6"
      title="Services externes"
      description="Appels de l'app vers Shopify, Whop, les régies publicitaires et les autres services : volume, erreurs et temps de réponse. p95 : 95 % des appels répondent plus vite que cette durée."
      className="mb-6"
    >
      {providers.length === 0 ? (
        <p className="text-sm text-zinc-600">Aucun appel enregistré sur les dernières 24 h.</p>
      ) : (
        <ul className="divide-y divide-zinc-100">
          {providers.map((p) => {
            const h = p.hour;
            const status = providerStatus(p);
            return (
              <li key={p.provider} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <h3 className="text-sm font-medium text-zinc-900">{p.label}</h3>
                  <Badge color={status.color}>{status.label}</Badge>
                </div>
                {status.reason && (status.level === "down" || status.level === "degraded") && (
                  <p className={`text-xs ${status.level === "down" ? "font-medium text-red-700" : "text-amber-800"}`}>
                    {status.level === "down" ? "En panne : " : "Dernière heure : "}
                    {status.reason}.
                  </p>
                )}
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-600 sm:grid-cols-4">
                  <div className="min-w-0">
                    <dt className="text-zinc-500">Appels 1 h / 24 h</dt>
                    <dd className="font-medium text-zinc-800 tabular-nums">
                      {count(h?.calls ?? 0)} / {count(p.day.calls)}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-zinc-500">Erreurs 1 h / 24 h</dt>
                    <dd className="font-medium text-zinc-800 tabular-nums">
                      {h ? pct(h.errors, h.calls) : "—"} / {pct(p.day.errors, p.day.calls)}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-zinc-500">p95 1 h / 24 h</dt>
                    <dd className="font-medium text-zinc-800 tabular-nums">
                      {secs(h?.p95Ms ?? null)} / {secs(p.day.p95Ms)}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-zinc-500">Dernier succès</dt>
                    <dd className="font-medium text-zinc-800">
                      {p.day.lastOkAt ? (
                        <time dateTime={p.day.lastOkAt.toISOString()} title={formatDateTimeLong(p.day.lastOkAt, tz)}>
                          {formatWhen(p.day.lastOkAt, now, tz)}
                        </time>
                      ) : (
                        "aucun sur 24 h"
                      )}
                    </dd>
                  </div>
                </dl>
                {p.day.lastErrorAt && (
                  <div className="text-xs text-zinc-600">
                    <span className="text-zinc-500">
                      Dernière erreur{" "}
                      <time dateTime={p.day.lastErrorAt.toISOString()} title={formatDateTimeLong(p.day.lastErrorAt, tz)}>
                        {formatWhen(p.day.lastErrorAt, now, tz)}
                      </time>{" "}
                      :
                    </span>
                    <ErrorText raw={p.day.lastError ?? "erreur inconnue"} provider={p.provider} className="text-zinc-700" />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
