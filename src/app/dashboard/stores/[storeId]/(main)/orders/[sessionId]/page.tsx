import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, History, MapPin, Package, RotateCcw, ShieldAlert, Sparkles, Tags } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { centsToDecimal, formatMoney, type CartLine } from "@/lib/pricing";
import { orderAdminUrl, type Address } from "@/lib/shopify";
import { Badge, Card, Flash, Input, SubmitButton } from "@/components/ui";
import { StatusBadge, SyncBadge } from "@/components/dashboard/OrderBits";
import { refundOrderAction, resyncOrderAction } from "../../../../../actions";

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string; sessionId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requireAdmin();
  const { storeId, sessionId } = await params;
  const sp = await searchParams;
  const s = await db.checkoutSession.findFirst({ where: { id: sessionId, storeId }, include: { store: true, upsells: true } });
  if (!s) notFound();
  const [events, quote] = await Promise.all([
    db.eventLog.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" } }),
    s.paidQuoteId ? db.checkoutQuote.findUnique({ where: { id: s.paidQuoteId } }) : null,
  ]);
  const money = (c: number) => formatMoney(c, s.currency);
  const lines = s.lines as unknown as CartLine[];
  const a = s.shippingAddress as Address | null;
  const utm = (s.utm ?? {}) as Record<string, string>;
  const addOns = (quote?.addOns ?? []) as { title: string; priceCents: number }[];
  const remaining = s.totalCents - s.refundedCents;
  const fmt = (d: Date) => d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium", timeZone: "Europe/Paris" });

  const timeline: { at: Date; label: string; tone?: "warn" | "error" }[] = [
    { at: s.createdAt, label: "Checkout ouvert depuis la boutique" },
    ...(s.preparedAt ? [{ at: s.preparedAt, label: "Formulaire de paiement prêt" }] : []),
    ...(s.termsAcceptedAt ? [{ at: s.termsAcceptedAt, label: "CGV acceptées" }] : []),
    ...(s.payClickedAt ? [{ at: s.payClickedAt, label: "Clic sur « Payer »" }] : []),
    ...events.map((e) => ({ at: e.createdAt, label: e.message, tone: e.level === "error" ? ("error" as const) : e.level === "warn" ? ("warn" as const) : undefined })),
  ].sort((x, y) => x.at.getTime() - y.at.getTime());

  return (
    <>
      <Link href={`/dashboard/stores/${storeId}/orders`} className="mb-4 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900">
        <ArrowLeft className="h-4 w-4" /> Commandes
      </Link>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{s.shopifyOrderName ?? (s.status === "PAID" ? "Commande payée" : "Checkout")}</h1>
        <StatusBadge status={s.status} disputed={s.disputed} />
        <span className="text-sm text-zinc-500">{fmt(s.paidAt ?? s.createdAt)}</span>
        {s.shopifyOrderId && s.store.shopDomain && (
          <a href={orderAdminUrl(s.store.shopDomain, s.shopifyOrderId)} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-sm shadow-[var(--shadow-card)] hover:bg-zinc-50">
            Ouvrir dans Shopify <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
      <Flash ok={sp.ok} error={sp.error} />

      {s.extraPaymentIds.length > 0 && (
        <div className="mb-6 flex items-start gap-3 rounded-xl bg-red-50 p-4 text-sm text-red-900 ring-1 ring-red-600/15">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
          <p>
            <strong>Paiement(s) en double</strong> reçu(s) pour ce panier : {s.extraPaymentIds.join(", ")}. La commande n&apos;est créée qu&apos;une fois ;
            remboursez le(s) doublon(s) dans Whop.
          </p>
        </div>
      )}

      {s.reviewNote && (
        <div className="mb-6 flex items-start gap-3 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-600/20">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="flex-1">
            <p className="font-medium whitespace-pre-line">{s.reviewNote}</p>
            {s.status === "PAID" && !s.shopifyOrderId && (
              <form action={resyncOrderAction.bind(null, storeId, s.id)} className="mt-3">
                <SubmitButton size="sm" variant="secondary" confirm="Créer quand même la commande dans Shopify ?">
                  Créer la commande dans Shopify
                </SubmitButton>
              </form>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <Card icon={Package} title="Articles">
            <ul className="divide-y divide-zinc-100">
              {lines.map((l) => (
                <li key={l.variantId} className="flex items-center gap-3 py-2.5">
                  {l.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.imageUrl} alt="" className="h-11 w-11 rounded-lg object-cover ring-1 ring-zinc-900/5" />
                  ) : (
                    <span className="h-11 w-11 rounded-lg bg-zinc-100" />
                  )}
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block truncate font-medium">{l.title}</span>
                    <span className="text-xs text-zinc-500">
                      {l.variantTitle ? `${l.variantTitle} · ` : ""}
                      {l.quantity} × {money(l.unitPriceCents)}
                    </span>
                  </span>
                  <span className="text-sm font-medium tabular-nums">{money(l.unitPriceCents * l.quantity)}</span>
                </li>
              ))}
              {addOns.map((x) => (
                <li key={x.title} className="flex justify-between py-2.5 text-sm">
                  <span>Option : {x.title}</span>
                  <span className="tabular-nums">{money(x.priceCents)}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-3 space-y-1.5 border-t border-zinc-100 pt-3 text-sm">
              <Row k="Sous-total" v={money(s.subtotalCents)} />
              {s.discountCents > 0 && <Row k={`Réduction${s.discountCode ? ` (${s.discountCode})` : ""}`} v={`−${money(s.discountCents)}`} />}
              {s.addOnsCents > 0 && <Row k="Options" v={money(s.addOnsCents)} />}
              <Row k={`Livraison${quote?.shippingRateName ? ` · ${quote.shippingRateName}` : ""}`} v={s.shippingCents ? money(s.shippingCents) : "Offerte"} />
              <div className="flex justify-between pt-1 text-base font-semibold">
                <dt>Total</dt>
                <dd className="tabular-nums">{money(s.totalCents || s.subtotalCents)}</dd>
              </div>
              {s.refundedCents > 0 && <Row k="Remboursé" v={`−${money(s.refundedCents)}`} />}
            </dl>
          </Card>

          {s.upsells.length > 0 && (
            <Card icon={Sparkles} iconColor="#a855f7" title="Offres post-achat">
              <ul className="space-y-2 text-sm">
                {s.upsells.map((u) => (
                  <li key={u.id} className="flex items-center justify-between gap-3">
                    <span>
                      {u.title} · {money(u.amountCents)}
                      {u.error && <span className="block text-xs text-red-600">{u.error}</span>}
                    </span>
                    <Badge color={u.status === "PAID" ? "green" : u.status === "DECLINED" ? "zinc" : u.status === "FAILED" ? "red" : "blue"}>
                      {u.status === "PAID" ? (u.shopifyOrderName ?? "Payée") : u.status === "DECLINED" ? "Refusée" : u.status === "FAILED" ? "Échec" : "En attente"}
                    </Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card icon={History} title="Chronologie">
            <ol className="relative space-y-3 border-l border-zinc-200 pl-5">
              {timeline.map((t, i) => (
                <li key={i} className="relative text-sm">
                  <span
                    className={`absolute top-1.5 -left-[25px] h-2.5 w-2.5 rounded-full ring-4 ring-white ${t.tone === "error" ? "bg-red-500" : t.tone === "warn" ? "bg-amber-500" : "bg-indigo-500"}`}
                  />
                  <span className="block text-zinc-800">{t.label}</span>
                  <time className="text-xs text-zinc-500">{fmt(t.at)}</time>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-6">
          <Card icon={MapPin} title="Client">
            <p className="text-sm font-medium">{s.email ?? "—"}</p>
            {a && (
              <address className="mt-2 text-sm leading-relaxed text-zinc-600 not-italic">
                {a.firstName} {a.lastName}
                <br />
                {a.address1}
                {a.address2 && (
                  <>
                    <br />
                    {a.address2}
                  </>
                )}
                <br />
                {a.zip} {a.city} · {a.countryCode}
                {a.phone && (
                  <>
                    <br />
                    {a.phone}
                  </>
                )}
              </address>
            )}
            {s.note && <p className="mt-3 rounded-lg bg-zinc-50 p-2.5 text-sm text-zinc-700">« {s.note} »</p>}
          </Card>

          <Card icon={Tags} title="Paiement & attribution">
            <dl className="space-y-1.5 text-sm">
              <Row k="Shopify" v={<SyncBadge s={s} />} />
              {s.whopPaymentId && <Row k="Paiement Whop" v={<code className="text-xs">{s.whopPaymentId}</code>} />}
              {s.paymentMethodType && <Row k="Moyen de paiement" v={s.paymentMethodType} />}
              {s.trackingNumber && <Row k="Suivi transmis à Whop" v={s.trackingNumber} />}
              <Row k="Source" v={utm.utm_source || (utm.fbclid ? "facebook (pub)" : utm.ttclid ? "tiktok (pub)" : "—")} />
              {utm.utm_campaign && <Row k="Campagne" v={utm.utm_campaign} />}
              {s.variant && <Row k="Test A/B" v={`Variante ${s.variant}`} />}
              {s.pixelSentAt && <Row k="Pixels" v="Achat envoyé" />}
            </dl>
            {s.syncError && !s.shopifyOrderId && (
              <p className="mt-3 text-xs break-words text-red-600">
                {s.syncError}
                {s.nextSyncAt && !s.reviewNote && (
                  <span className="block text-zinc-500">
                    Nouvel essai automatique le {s.nextSyncAt.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" })} (essai {s.syncAttempts + 1})
                  </span>
                )}
              </p>
            )}
            {s.status === "PAID" && !s.shopifyOrderId && !s.reviewNote && (
              <form action={resyncOrderAction.bind(null, storeId, s.id)} className="mt-3">
                <SubmitButton size="sm" variant="secondary">
                  Re-synchroniser maintenant
                </SubmitButton>
              </form>
            )}
          </Card>

          {s.status === "PAID" && s.whopPaymentId && remaining > 0 && (
            <Card icon={RotateCcw} iconColor="#dc2626" title="Rembourser" description="Remboursé via Whop, puis reporté automatiquement sur la commande Shopify.">
              <form action={refundOrderAction.bind(null, storeId, s.id)} className="flex gap-2">
                <Input name="amount" inputMode="decimal" defaultValue={centsToDecimal(remaining)} aria-label="Montant à rembourser" className="w-32" />
                <SubmitButton variant="danger" confirm="Confirmer le remboursement ? Il est définitif.">
                  Rembourser
                </SubmitButton>
              </form>
              <p className="mt-2 text-xs text-zinc-500">Maximum : {money(remaining)}</p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-zinc-500">{k}</dt>
      <dd className="text-right font-medium">{v}</dd>
    </div>
  );
}
