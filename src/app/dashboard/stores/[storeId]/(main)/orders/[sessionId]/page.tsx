import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  CircleUserRound,
  CreditCard,
  ExternalLink,
  FileCheck2,
  History,
  Mail,
  MapPin,
  Megaphone,
  MousePointerClick,
  Package,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Tags,
  Truck,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import type { CartLine } from "@/lib/pricing";
import { orderAdminUrl, type Address } from "@/lib/shopify";
import { Badge, Card, Flash, Label, Select, SubmitButton, Textarea, buttonClass } from "@/components/ui";
import { PROTECTION_ADDON_ID } from "@/lib/analytics";
import { CLAIM_KINDS, REASON_LABELS, replacementItems, replacementWaitMinutes, type BuyerReason, type ClaimKind } from "@/lib/claims";

/** Photos sent by the buyer with a report (served to the signed-in merchant only). */
function ClaimPhotos({ storeId, photos }: { storeId: string; photos: { id: string; mime: string; size: number }[] }) {
  if (!photos.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2" aria-label="Photos envoyées par le client">
      {photos.map((p, i) => {
        const href = `/dashboard/stores/${storeId}/claims/photos/${p.id}`;
        return (
          <li key={p.id}>
            <a href={href} target="_blank" rel="noopener noreferrer" className="block rounded-lg ring-1 ring-zinc-900/10 hover:ring-indigo-400">
              {/^image\/hei[cf]$/.test(p.mime) ? (
                <span className="flex h-16 w-16 items-center justify-center text-[11px] text-zinc-600">Photo {i + 1} (HEIC)</span>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- private route, no image optimizer
                <img src={href} alt={`Photo ${i + 1} envoyée par le client`} className="h-16 w-16 rounded-lg object-cover" loading="lazy" />
              )}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
import { approveClaimAction, createReplacementAction, declareClaimAction, deleteClaimAction, rejectClaimAction } from "./actions";
import { ConfirmButton } from "@/components/dashboard/ConfirmButton";
import { CopyField } from "@/components/dashboard/CopyField";
import { formatCents } from "@/components/dashboard/format";
import { formatDateTimeLong } from "@/components/dashboard/dates";
import { tzOf } from "@/lib/time";
import { splitTechnical } from "@/components/dashboard/journal";
import { claimTimelineLabel } from "@/components/dashboard/claimTimeline";
import { StatusBadge, SyncBadge } from "@/components/dashboard/OrderBits";
import { Thumb } from "@/components/dashboard/Thumb";
import { RefundForm } from "@/components/dashboard/RefundForm";
import { markOrderHandledAction, refundOrderAction, resyncOrderAction, retryShopifySyncAction } from "../../../../../actions";
import { PopoverDetails } from "@/components/dashboard/Popover";
import { ErrorText } from "@/components/dashboard/ErrorText";
import { ReshipOnly } from "@/components/dashboard/ReshipOnly";
import { ClaimCostInput } from "@/components/dashboard/ClaimCostInput";
import type { ClaimCostItem } from "@/lib/claim-cost";
import { sourceLabel } from "@/components/dashboard/sources";
import { countryName } from "@/components/dashboard/countries";
import { humanizeError } from "@/lib/humanize-error";

const METHOD_LABEL: Record<string, string> = {
  card: "Carte bancaire",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  paypal: "PayPal",
  klarna: "Klarna",
  afterpay_clearpay: "Afterpay / Clearpay",
  affirm: "Affirm",
  ideal: "iDEAL",
  bancontact: "Bancontact",
  sepa_debit: "Prélèvement SEPA",
};
const methodLabel = (m: string | null) => (m ? (METHOD_LABEL[m] ?? m.replace(/_/g, " ")) : null);

export async function generateMetadata({ params }: { params: Promise<{ storeId: string; sessionId: string }> }): Promise<Metadata> {
  const { storeId, sessionId } = await params;
  const s = await db.checkoutSession.findFirst({ where: { id: sessionId, storeId }, select: { shopifyOrderName: true, status: true } });
  if (!s) return { title: "Commande introuvable" };
  return { title: s?.shopifyOrderName ? `Commande ${s.shopifyOrderName}` : s?.status === "PAID" ? "Commande payée" : "Checkout" };
}

type Tone = "warn" | "error" | "success";
type TimelineItem = { at: Date; label: string; tone?: Tone; icon: LucideIcon; details?: string | null };

/** Icon + tone of a journal event in the order timeline. */
function eventLook(kind: string, level: string): { icon: LucideIcon; tone?: Tone } {
  const tone: Tone | undefined = level === "error" ? "error" : level === "warn" ? "warn" : undefined;
  if (kind === "order.synced") return { icon: ShoppingBag, tone: "success" };
  if (kind.startsWith("sync.") || kind === "order.oversold") return { icon: AlertTriangle, tone: tone ?? "warn" };
  if (kind.startsWith("refund.") || kind.startsWith("reconcile.refund")) return { icon: RotateCcw, tone };
  if (kind.startsWith("dispute")) return { icon: ShieldAlert, tone: tone ?? "warn" };
  if (kind === "review.hold" || kind === "payment.duplicate") return { icon: ShieldAlert, tone: tone ?? "warn" };
  if (kind.startsWith("payment.")) return { icon: CreditCard, tone };
  if (kind.startsWith("tracking.")) return { icon: Truck, tone };
  if (kind.startsWith("upsell.")) return { icon: Sparkles, tone };
  if (kind.startsWith("conversion.")) return { icon: Megaphone, tone };
  if (kind === "protection.claim_reported") return { icon: ShieldAlert, tone: tone ?? "warn" };
  if (kind.startsWith("protection.")) return { icon: ShieldCheck, tone };
  if (kind.startsWith("webhook.")) return { icon: Webhook, tone };
  return { icon: CircleDot, tone };
}

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
  const s = await db.checkoutSession.findFirst({ where: { id: sessionId, storeId }, include: { store: true, upsells: true, protectionClaims: { orderBy: { createdAt: "asc" }, include: { photos: { select: { id: true, mime: true, size: true } } } } } });
  if (!s) notFound();
  const [events, quote, cartSnapshot] = await Promise.all([
    db.eventLog.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" } }),
    s.paidQuoteId ? db.checkoutQuote.findUnique({ where: { id: s.paidQuoteId } }) : null,
    db.cartSnapshot.findUnique({ where: { sessionId } }),
  ]);
  const money = (c: number) => formatCents(c, s.currency);
  const lines = s.lines as unknown as CartLine[];
  const a = s.shippingAddress as Address | null;
  const utm = (s.utm ?? {}) as Record<string, string>;
  const addOns = (quote?.addOns ?? []) as { id?: string; title: string; priceCents: number }[];
  const protectedParcel = addOns.some((x) => x.id === PROTECTION_ADDON_ID);
  // Only accepted claims cost something (a buyer's report waiting for a decision doesn't, a refused one never).
  const claimsTotal = s.protectionClaims.filter((c) => c.status === "approved").reduce((t, c) => t + c.costCents, 0);
  const pendingClaims = s.protectionClaims.filter((c) => c.status === "pending");
  // What a replacement order can contain (the merchant unticks what isn't sent again).
  const reshipItems = pendingClaims.length
    ? replacementItems(
        ((quote?.lines ?? s.lines) as unknown as CartLine[]) ?? [],
        addOns as { id?: string; title?: string; priceCents?: number; variantId?: string | null }[],
        s.upsells.map((u) => ({ id: u.id, title: u.title, variantId: u.variantId, quantity: u.quantity, amountCents: u.amountCents, refundedCents: u.refundedCents, status: u.status, orderMode: u.orderMode })),
      )
    : [];
  const remaining = s.totalCents - s.refundedCents;
  // Claim cost prefill: purchase cost of each item a reship can contain (unit cost × quantity) + the carrier cost of the paid rate.
  const claimCard = s.status === "PAID" && (protectedParcel || s.protectionClaims.length > 0);
  const claimItems: ClaimCostItem[] = claimCard
    ? replacementItems(
        ((quote?.lines ?? s.lines) as unknown as CartLine[]) ?? [],
        addOns as { id?: string; title?: string; priceCents?: number; variantId?: string | null }[],
        s.upsells.map((u) => ({ id: u.id, title: u.title, variantId: u.variantId, quantity: u.quantity, amountCents: u.amountCents, refundedCents: u.refundedCents, status: u.status, orderMode: u.orderMode })),
      ).map((it) => {
        const [kind, ref] = [it.key.slice(0, it.key.indexOf(":")), it.key.slice(it.key.indexOf(":") + 1)];
        const unit =
          kind === "line"
            ? (lines[Number(ref)]?.unitCostCents ?? ((quote?.lines ?? []) as unknown as CartLine[])[Number(ref)]?.unitCostCents ?? null)
            : kind === "addon"
              ? ((addOns as { id?: string; costCents?: number | null }[]).find((x) => x.id === ref)?.costCents ?? null)
              : (s.upsells.find((u) => u.id === ref)?.costCents ?? null);
        return { key: it.key, costCents: unit == null ? null : unit * it.quantity };
      })
    : [];
  const carrierCents = claimCard
    ? (quote?.shippingCostCents ??
      ((quote?.shippingRateId ?? s.shippingRateId)
        ? ((await db.shippingRate.findUnique({ where: { id: (quote?.shippingRateId ?? s.shippingRateId)! }, select: { costCents: true } }))?.costCents ?? null)
        : null))
    : null;
  // Dates in the store's time zone (Paris by default).
  const fmt = (d: Date) => formatDateTimeLong(d, tzOf(s.store));
  const method = methodLabel(s.paymentMethodType);
  const whopDashboard = s.store.testMode ? "https://sandbox.whop.com/dashboard" : "https://whop.com/dashboard";
  // Shown once (header): only when the Shopify order is missing or its last sync failed.
  const needsSync = s.status === "PAID" && (!s.shopifyOrderId || !!s.syncError);
  const canRetrySync = needsSync && !s.shopifyOrderId && !s.reviewNote && !s.syncHandledAt;

  const paidLabel = `Paiement reçu · ${money(s.totalCents || s.subtotalCents)}${method ? ` · ${method}` : ""}`;
  const hasEvent = (p: string) => events.some((e) => e.kind === p || e.kind.startsWith(`${p}.`));
  const timeline: TimelineItem[] = [
    { at: s.createdAt, label: "Checkout ouvert depuis la boutique", icon: ShoppingCart },
    ...(s.emailEnteredAt ? [{ at: s.emailEnteredAt, label: "E-mail saisi", icon: Mail }] : []),
    ...(s.addressEnteredAt ? [{ at: s.addressEnteredAt, label: "Adresse de livraison saisie", icon: MapPin }] : []),
    ...(s.shippingChosenAt ? [{ at: s.shippingChosenAt, label: `Livraison choisie${quote?.shippingRateName ? ` · ${quote.shippingRateName}` : ""}`, icon: Truck }] : []),
    ...(s.preparedAt ? [{ at: s.preparedAt, label: "Formulaire de paiement prêt", icon: CreditCard }] : []),
    ...(s.termsAcceptedAt ? [{ at: s.termsAcceptedAt, label: "CGV acceptées", icon: FileCheck2 }] : []),
    ...(s.payClickedAt ? [{ at: s.payClickedAt, label: "Clic sur « Payer »", icon: MousePointerClick }] : []),
    ...(s.paidAt && s.status === "PAID" && !events.some((e) => e.kind === "payment.succeeded")
      ? [{ at: s.paidAt, label: paidLabel, tone: "success" as const, icon: CheckCircle2 }]
      : []),
    // Orders synced before the journal recorded it: the Shopify order is created right after payment.
    ...(s.shopifyOrderName && s.paidAt && !hasEvent("order.synced")
      ? [{ at: new Date(s.paidAt.getTime() + 1), label: `Commande Shopify ${s.shopifyOrderName} créée`, tone: "success" as const, icon: ShoppingBag }]
      : []),
    ...(s.disputeOpenedAt && !hasEvent("dispute") ? [{ at: s.disputeOpenedAt, label: "Litige ouvert par le client", tone: "warn" as const, icon: ShieldAlert }] : []),
    ...events.map((e): TimelineItem => {
      const look = eventLook(e.kind, e.level);
      if (e.kind === "payment.succeeded") return { at: e.createdAt, label: paidLabel, tone: "success", icon: CheckCircle2 };
      if (e.kind === "order.synced") {
        const name = /#[\w-]+/.exec(e.message)?.[0] ?? s.shopifyOrderName;
        return { at: e.createdAt, label: name ? `Commande Shopify ${name} créée` : e.message, ...look };
      }
      const claimLabel = claimTimelineLabel(e.kind, e.message, e.data);
      if (claimLabel) return { at: e.createdAt, label: claimLabel, ...look };
      const { summary, details } = splitTechnical(e.message);
      return { at: e.createdAt, label: summary, details, ...look };
    }),
  ].sort((x, y) => x.at.getTime() - y.at.getTime());

  return (
    <>
      <Link
        href={`/dashboard/stores/${storeId}/orders`}
        className="mb-4 inline-flex min-h-8 items-center gap-1.5 rounded-md text-sm text-zinc-600 hover:text-zinc-900"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Commandes
      </Link>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 sm:mb-7 sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.02em] text-zinc-900 sm:text-[26px]">
              {s.shopifyOrderName ?? (s.status === "PAID" ? "Commande payée" : "Checkout")}
            </h1>
            <StatusBadge status={s.status} disputed={s.disputed} />
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            {s.status === "PAID" && s.paidAt ? `Payée le ${fmt(s.paidAt)}` : `Ouvert le ${fmt(s.createdAt)}`} · {money(s.totalCents || s.subtotalCents)}
            {method && <span className="hidden sm:inline"> · {method}</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canRetrySync && (
            <form action={retryShopifySyncAction.bind(null, storeId, s.id)}>
              <SubmitButton variant="secondary" className="min-h-9" aria-label="Relancer la synchro Shopify">
                <RefreshCw className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">Relancer la synchro Shopify</span>
                <span className="sm:hidden">Relancer</span>
              </SubmitButton>
            </form>
          )}
          {canRetrySync && !s.syncHandledAt && s.syncAttempts > 0 && (
            <PopoverDetails className="relative">
              <summary className={`${buttonClass("secondary")} min-h-9 cursor-pointer list-none`}>Commande créée à la main…</summary>
              <form action={markOrderHandledAction.bind(null, storeId, s.id)} className="absolute right-0 z-20 mt-2 w-72 space-y-2 rounded-xl bg-white p-3 text-sm shadow-lg ring-1 ring-zinc-900/10">
                <label htmlFor="handled-order" className="block font-medium">
                  Numéro de la commande Shopify
                </label>
                <input id="handled-order" name="orderName" required placeholder="#1234" className="w-full rounded-lg border border-zinc-300 px-2.5 py-1.5" />
                <p className="text-xs text-zinc-500">Plus aucune création automatique pour ce paiement. Les remboursements seront à reporter à la main.</p>
                <SubmitButton size="sm">Lier la commande</SubmitButton>
              </form>
            </PopoverDetails>
          )}
          {s.shopifyOrderId && s.store.shopDomain && (
            <a
              href={orderAdminUrl(s.store.shopDomain, s.shopifyOrderId)}
              target="_blank"
              rel="noreferrer"
              aria-label="Ouvrir dans Shopify (nouvel onglet)"
              className={`${buttonClass("secondary")} min-h-9`}
            >
              <span className="hidden sm:inline">Ouvrir dans Shopify</span>
              <span className="sm:hidden">Shopify</span> <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          )}
        </div>
      </div>
      <Flash ok={sp.ok} error={sp.error} />

      {s.extraPaymentIds.length > 0 && (
        <div className="mb-6 flex items-start gap-3 rounded-xl bg-red-50 p-4 text-sm text-red-900 ring-1 ring-red-600/15">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          <p>
            <strong>Paiement(s) en double</strong> reçu(s) pour ce panier : <span className="font-mono break-all">{s.extraPaymentIds.join(", ")}</span>. La
            commande n&apos;est créée qu&apos;une fois ; remboursez le(s) doublon(s){" "}
            <a href={whopDashboard} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
              dans Whop → Paiements
            </a>
            .
          </p>
        </div>
      )}

      {s.syncSkippedReason && !s.shopifyOrderId && (
        <div className="mb-6 flex items-start gap-3 rounded-xl bg-zinc-50 p-4 text-sm text-zinc-800 ring-1 ring-zinc-900/10">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          <p>
            <strong>Non créée dans Shopify.</strong>{" "}
            {s.syncSkippedReason === "refunded"
              ? "Commande remboursée avant création : commande non créée dans Shopify (rien à expédier)."
              : "Litige perdu avant création : commande non créée dans Shopify (fonds rendus au client)."}{" "}
            Si le client doit tout de même être livré, créez la commande à la main dans Shopify.
          </p>
        </div>
      )}

      {s.reviewNote && (
        <div className="mb-6 flex items-start gap-3 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-600/20">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          <div className="flex-1">
            <p className="font-medium whitespace-pre-line">{s.reviewNote}</p>
            {s.status === "PAID" && !s.shopifyOrderId && (
              <form action={resyncOrderAction.bind(null, storeId, s.id)} className="mt-3">
                <ConfirmButton
                  variant="secondary"
                  size="sm"
                  tone="default"
                  title="Créer quand même la commande dans Shopify ?"
                  description="Le paiement a été mis de côté pour vérification. Confirmez seulement si vous avez vérifié le paiement dans Whop."
                  confirmLabel="Créer la commande"
                >
                  Créer la commande dans Shopify
                </ConfirmButton>
              </form>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[1.4fr_1fr] [&>*]:min-w-0">
        <div className="space-y-6">
          <Card icon={Package} title="Articles">
            <ul className="divide-y divide-zinc-100">
              {lines.map((l) => (
                <li key={l.variantId} className="flex items-center gap-3 py-2.5">
                  <Thumb src={l.imageUrl} size={44} />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block truncate font-medium">{l.title}</span>
                    <span className="text-xs text-zinc-500">
                      {l.variantTitle ? `${l.variantTitle} · ` : ""}
                      {l.quantity} × {money(l.unitPriceCents)}
                      {l.appPrice ? ` (prix de lot d'app, catalogue ${money(l.appPrice.originalUnitCents)})` : ""}
                    </span>
                    {/* Line item properties as sent to Shopify (hidden "_…" app keys dimmed). */}
                    {(l.properties ?? []).map((p) => (
                      <span key={p.name} className={`block truncate text-xs ${p.name.startsWith("_") ? "text-zinc-400" : "text-zinc-600"}`} title={p.value}>
                        {p.name} : {p.value}
                      </span>
                    ))}
                    {l.components?.length ? <span className="block text-xs text-zinc-500">Lot commandé en {l.components.length} composant(s)</span> : null}
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
            {cartSnapshot && (
              // Redacted /cart.js (apps' lines, amounts, hidden keys), kept 7 days: to send to support.
              <details className="mt-3 border-t border-zinc-100 pt-3 text-xs text-zinc-600">
                <summary className="cursor-pointer">
                  Panier Shopify (diagnostic, 7 jours){cartSnapshot.apps.length ? ` · apps : ${cartSnapshot.apps.join(", ")}` : ""}
                  {cartSnapshot.unknownKeys.length ? ` · clés inconnues : ${cartSnapshot.unknownKeys.join(", ")}` : ""}
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto rounded bg-zinc-50 p-2 font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify(cartSnapshot.data, null, 2)}</pre>
              </details>
            )}
          </Card>

          {s.upsells.length > 0 && (
            <Card icon={Sparkles} iconColor="#a855f7" title="Offres post-achat">
              <ul className="space-y-2 text-sm">
                {s.upsells.map((u) => (
                  <li key={u.id} className="flex items-center justify-between gap-3">
                    <span>
                      {u.title} · {money(u.amountCents)}
                      {u.error && <ErrorText raw={u.error} className="text-xs text-red-600" />}
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <Badge color={u.status === "PAID" ? "green" : u.status === "DECLINED" ? "zinc" : u.status === "FAILED" ? "red" : "blue"}>
                        {u.status === "PAID" ? (u.shopifyOrderName ?? "Payée") : u.status === "DECLINED" ? "Refusée" : u.status === "FAILED" ? "Échec" : "En attente"}
                      </Badge>
                      {u.status === "PAID" && u.orderMode && (
                        <span className="text-[11px] text-zinc-500">{u.orderMode === "merged" ? "Ajoutée à la commande d'origine" : "Commande Shopify séparée"}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {s.status === "PAID" && (protectedParcel || s.protectionClaims.length > 0) && (
            <Card
              id="sinistres"
              icon={ShieldCheck}
              iconColor="#0d9488"
              title="Protection colis · sinistres"
              description={
                protectedParcel
                  ? "Colis perdu, volé ou abîmé : notez ce que vous a coûté la solution (renvoi, remboursement hors Whop). Déduit de la marge et du résultat de la protection dans Analytics."
                  : "Cette commande n'a pas pris la protection colis : un sinistre reste déduit de sa marge."
              }
            >
              {pendingClaims.map((c) => (
                <div key={c.id} role="group" aria-label="Signalement du client à traiter" className="mb-4 rounded-xl bg-amber-50 p-3 text-sm ring-1 ring-amber-600/20">
                  <p className="font-medium text-amber-900">
                    Signalement du client · {REASON_LABELS[c.reason as BuyerReason] ?? c.reason ?? "problème de livraison"} · {fmt(c.createdAt)}
                  </p>
                  {c.note && <p className="mt-1 break-words whitespace-pre-line text-amber-950">{c.note}</p>}
                  {c.photoUrl && (
                    <p className="mt-1">
                      <a href={c.photoUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-indigo-700 underline">
                        Voir la photo envoyée par le client
                      </a>
                    </p>
                  )}
                  <ClaimPhotos storeId={storeId} photos={c.photos} />
                  {/* One form: "Accepter" submits the solution and cost, "Refuser" (same row) posts to the reject action. */}
                  <form action={approveClaimAction.bind(null, storeId, s.id, c.id)} className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <div>
                      <Label htmlFor={`claim-kind-${c.id}`}>Solution</Label>
                      <Select id={`claim-kind-${c.id}`} name="kind" defaultValue="reship">
                        {Object.entries(CLAIM_KINDS).map(([k, label]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <ClaimCostInput id={`claim-cost-${c.id}`} label={`Coût pour vous (${s.currency})`} kindSelectId={`claim-kind-${c.id}`} items={claimItems} carrierCents={carrierCents} refundCents={Math.max(0, remaining)} currency={s.currency} />
                    </div>
                    <ReshipOnly selectId={`claim-kind-${c.id}`}>
                      <label htmlFor={`claim-repl-${c.id}`} className="flex items-start gap-2 text-xs text-amber-950 sm:order-last sm:col-span-3">
                        <input id={`claim-repl-${c.id}`} type="checkbox" name="replacement" defaultChecked className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600" />
                        <span>Renvoi : créer la commande de remplacement à 0 € dans Shopify (articles cochés ci-dessous, étiquette « remplacement »). Le client est prévenu par e-mail dans sa langue.</span>
                      </label>
                      {reshipItems.length > 0 && (
                        <fieldset className="text-xs text-amber-950 sm:order-last sm:col-span-3">
                          <legend className="font-medium">Articles à renvoyer</legend>
                          <input type="hidden" name="rlines" value="1" />
                          <ul className="mt-1 space-y-1">
                            {reshipItems.map((it) => (
                              <li key={it.key}>
                                <label htmlFor={`claim-rl-${c.id}-${it.key}`} className="flex min-h-6 items-start gap-2">
                                  <input id={`claim-rl-${c.id}-${it.key}`} type="checkbox" name="rline" value={it.key} defaultChecked className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600" />
                                  <span>
                                    {it.quantity} × {it.title}
                                    {it.key.startsWith("offer:") ? " (offre post-achat)" : it.key.startsWith("addon:") ? " (option)" : ""}
                                  </span>
                                </label>
                              </li>
                            ))}
                          </ul>
                        </fieldset>
                      )}
                    </ReshipOnly>
                    <div className="flex flex-nowrap gap-2">
                      <SubmitButton size="sm" className="flex-1 whitespace-nowrap sm:flex-none">
                        Accepter
                      </SubmitButton>
                      <SubmitButton size="sm" variant="secondary" formAction={rejectClaimAction.bind(null, storeId, s.id, c.id)} formNoValidate className="flex-1 whitespace-nowrap sm:flex-none">
                        Refuser
                      </SubmitButton>
                    </div>
                  </form>
                </div>
              ))}
              {s.protectionClaims.some((c) => c.status !== "pending") && (
                <ul className="mb-4 divide-y divide-zinc-100 border-y border-zinc-100 text-sm">
                  {s.protectionClaims.filter((c) => c.status !== "pending").map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                      <span className="min-w-0">
                        <span className="font-medium">{CLAIM_KINDS[c.kind as ClaimKind] ?? c.kind}</span> · {c.status === "rejected" ? "refusé (non compté)" : money(c.costCents)}
                        {c.source === "buyer" && <span className="text-xs text-zinc-500"> · signalé par le client</span>}
                        <span className="block text-xs break-words text-zinc-500">
                          {fmt(c.createdAt)}
                          {c.note ? ` · ${c.note}` : ""}
                          {c.buyerNotifiedAt ? " · client prévenu par e-mail" : ""}
                        </span>
                        {c.replacementOrderName && <span className="block text-xs text-emerald-700">Commande de remplacement {c.replacementOrderName} (0 €)</span>}
                        {c.status === "approved" && c.kind === "reship" && !c.replacementOrderId && (() => {
                          // After an attempt without a sure answer from Shopify: anti-duplicate wait before any new try.
                          const wait = replacementWaitMinutes(c.replacementAmbiguousAt);
                          return (
                            <form action={createReplacementAction.bind(null, storeId, s.id, c.id)} className="mt-1">
                              {c.replacementError && <ErrorText raw={c.replacementError} prefix="Échec : " className="text-xs text-rose-700" />}
                              {wait > 0 && (
                                <span role="status" className="mb-1 block text-xs text-amber-800">
                                  Vérification anti-doublon : la commande a peut-être été créée. Réessayez dans {wait} min (elle sera d&apos;abord recherchée dans Shopify).
                                </span>
                              )}
                              <SubmitButton size="sm" variant="secondary" disabled={wait > 0}>
                                Créer la commande de remplacement (0 €)
                              </SubmitButton>
                            </form>
                          );
                        })()}
                        <ClaimPhotos storeId={storeId} photos={c.photos} />
                      </span>
                      <form action={deleteClaimAction.bind(null, storeId, s.id, c.id)}>
                        <ConfirmButton size="icon" aria-label="Supprimer ce sinistre" title="Supprimer ce sinistre ?" description="Son coût ne sera plus déduit de la marge.">
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </ConfirmButton>
                      </form>
                    </li>
                  ))}
                  <li className="flex justify-between py-2 font-medium">
                    <span>Total des sinistres</span>
                    <span className="tabular-nums">{money(claimsTotal)}</span>
                  </li>
                </ul>
              )}
              <details className="group">
                <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-medium text-indigo-700 hover:underline [&::-webkit-details-marker]:hidden">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Déclarer un sinistre
                </summary>
                <form action={declareClaimAction.bind(null, storeId, s.id)} className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="claim-kind">Solution</Label>
                    <Select id="claim-kind" name="kind" defaultValue="reship">
                      {Object.entries(CLAIM_KINDS).map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <ClaimCostInput id="claim-cost" label={`Coût pour vous (${s.currency})`} hint="Produit + port du renvoi, ou montant remboursé" kindSelectId="claim-kind" items={claimItems} carrierCents={carrierCents} refundCents={Math.max(0, remaining)} currency={s.currency} />
                  </div>
                  <div className="sm:col-span-2">
                    <Label htmlFor="claim-note" hint="Facultatif">
                      Note
                    </Label>
                    <Textarea id="claim-note" name="note" rows={2} maxLength={300} placeholder="Colis perdu par le transporteur, renvoyé le …" />
                  </div>
                  <p className="text-xs text-zinc-500 sm:col-span-2">Un remboursement fait dans Whop est déjà compté comme remboursement : ne le déclarez pas ici.</p>
                  <div className="sm:col-span-2">
                    <SubmitButton>Enregistrer le sinistre</SubmitButton>
                  </div>
                </form>
              </details>
            </Card>
          )}

          <Card icon={History} title="Chronologie">
            <ol className="space-y-0">
              {timeline.map((t, i) => {
                const Icon = t.icon;
                const last = i === timeline.length - 1;
                return (
                  <li key={i} className="relative flex gap-3 pb-4 text-sm last:pb-0">
                    {!last && <span aria-hidden className="absolute top-8 bottom-0 left-[13px] w-px bg-zinc-200" />}
                    <span
                      aria-hidden
                      className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1 ${
                        t.tone === "error"
                          ? "bg-red-50 text-red-600 ring-red-600/15"
                          : t.tone === "warn"
                            ? "bg-amber-50 text-amber-700 ring-amber-600/20"
                            : t.tone === "success"
                              ? "bg-emerald-50 text-emerald-600 ring-emerald-600/15"
                              : "bg-zinc-50 text-zinc-500 ring-zinc-900/10"
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <span className={`block break-words ${t.tone === "success" ? "font-medium text-zinc-900" : t.tone === "error" ? "text-red-800" : "text-zinc-800"}`}>
                        {t.tone === "error" && <span className="sr-only">Erreur : </span>}
                        {t.label}
                      </span>
                      <time className="text-xs text-zinc-500" dateTime={t.at.toISOString()}>
                        {fmt(t.at)}
                      </time>
                      {t.details && (
                        <details className="group mt-1">
                          <summary className="inline-flex min-h-7 cursor-pointer list-none items-center gap-1 rounded-md text-xs font-medium text-zinc-600 hover:text-zinc-900 [&::-webkit-details-marker]:hidden">
                            Détails techniques <ChevronDown className="h-3 w-3 transition group-open:rotate-180" aria-hidden />
                          </summary>
                          <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-zinc-50 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-700 ring-1 ring-zinc-900/5">
                            {t.details}
                          </pre>
                        </details>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </Card>
        </div>

        <div className="space-y-6">
          <Card icon={MapPin} title="Client">
            {s.email || a ? (
              <>
                {s.email ? (
                  <a href={`mailto:${s.email}`} className="text-sm font-medium break-all text-zinc-900 underline-offset-2 hover:underline">
                    {s.email}
                  </a>
                ) : (
                  <p className="text-sm text-zinc-500 italic">E-mail non renseigné</p>
                )}
                {a && (
                  <address className="mt-2 text-sm leading-relaxed text-zinc-600 not-italic">
                    {[
                      [a.firstName, a.lastName].filter(Boolean).join(" "),
                      a.address1,
                      a.address2,
                      [[a.zip, a.city].filter(Boolean).join(" "), a.countryCode ? countryName(a.countryCode) : null].filter(Boolean).join(" · "),
                      a.phone,
                    ]
                      .map((line) => line?.trim())
                      .filter(Boolean)
                      .map((line, i) => (
                        <span key={i} className="block">
                          {line}
                        </span>
                      ))}
                  </address>
                )}
              </>
            ) : (
              <div className="flex items-start gap-3 rounded-xl bg-zinc-50 p-3.5 ring-1 ring-zinc-900/5">
                <CircleUserRound className="mt-0.5 h-5 w-5 shrink-0 text-zinc-500" aria-hidden />
                <div className="text-sm">
                  <p className="font-medium text-zinc-900">{s.status === "PAID" ? "Coordonnées non transmises" : "Pas encore de coordonnées"}</p>
                  <p className="mt-0.5 text-zinc-600">
                    {s.status === "PAID"
                      ? "Le paiement ne contenait ni e-mail ni adresse. Retrouvez l'acheteur dans Whop avec l'ID du paiement."
                      : "Le client a ouvert le checkout mais n'a pas encore saisi son e-mail ni son adresse. Ils s'afficheront ici dès qu'il les renseigne."}
                  </p>
                </div>
              </div>
            )}
            {s.note && <p className="mt-3 rounded-lg bg-zinc-50 p-2.5 text-sm text-zinc-700">« {s.note} »</p>}
          </Card>

          <Card icon={Tags} title="Paiement & attribution">
            <dl className="space-y-1.5 text-sm">
              <Row k="Shopify" v={<SyncBadge s={s} />} />
              {s.whopPaymentId && <Row k="Paiement Whop" v={<code className="text-xs break-all">{s.whopPaymentId}</code>} />}
              {(method || s.status === "PAID") && (
                <Row
                  k="Moyen de paiement"
                  v={
                    method ? (
                      <span className="inline-flex items-center gap-1.5">
                        <CreditCard className="h-3.5 w-3.5 text-zinc-400" aria-hidden />
                        {method}
                      </span>
                    ) : (
                      <span className="font-normal text-zinc-500">Non transmis par Whop</span>
                    )
                  }
                />
              )}
              {s.trackingNumber && <Row k="Suivi transmis à Whop" v={s.trackingNumber} />}
              <Row k="Source" v={(utm.utm_source && sourceLabel(utm.utm_source.toLowerCase())) || (utm.fbclid ? "Facebook (pub)" : utm.ttclid ? "TikTok (pub)" : "Directe ou inconnue")} />
              {utm.utm_campaign && <Row k="Campagne" v={utm.utm_campaign} />}
              {s.variant && <Row k="Test A/B" v={`Variante ${s.variant}`} />}
              {s.pixelSentAt && <Row k="Pixels" v="Achat envoyé" />}
              {(s.googleAdsUploadedAt || s.googleAdsUploadError) && (
                <Row
                  k="Google Ads"
                  v={
                    s.googleAdsRetractedAt ? (
                      "Conversion retirée (remboursée / litige perdu)"
                    ) : s.googleAdsUploadedAt ? (
                      `Conversion envoyée${s.googleAdsValueCents != null ? ` · ${money(s.googleAdsValueCents)}` : ""}`
                    ) : (
                      <ErrorText raw={s.googleAdsUploadError} prefix="Non envoyée : " className="font-normal text-rose-700" />
                    )
                  }
                />
              )}
              {s.googleAdsAdjustError && !s.googleAdsRetractedAt && <Row k="Ajustement Google Ads" v={<ErrorText raw={s.googleAdsAdjustError} className="font-normal text-rose-700" />} />}
            </dl>
            {s.syncError && !s.shopifyOrderId && (
              <div className="mt-3 rounded-lg bg-red-50 p-2.5 text-xs text-red-800 ring-1 ring-red-600/15">
                <p className="font-medium">La création de la commande Shopify a échoué.</p>
                {humanizeError(s.syncError).detail && <p className="mt-0.5">{humanizeError(s.syncError).text}</p>}
                {s.nextSyncAt && !s.reviewNote && (
                  <p className="mt-0.5 text-red-700">
                    Nouvel essai automatique le {fmt(s.nextSyncAt)} (essai {s.syncAttempts + 1}).
                  </p>
                )}
                <details className="group mt-1">
                  <summary className="inline-flex min-h-7 cursor-pointer list-none items-center gap-1 rounded-md font-medium text-red-800 hover:underline [&::-webkit-details-marker]:hidden">
                    Détails techniques <ChevronDown className="h-3 w-3 transition group-open:rotate-180" aria-hidden />
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-white/70 p-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-zinc-700">
                    {s.syncError}
                  </pre>
                </details>
              </div>
            )}
          </Card>

          {s.status === "PAID" && s.whopPaymentId && remaining > 0 && (
            <Card icon={RotateCcw} iconColor="#dc2626" title="Rembourser" description="Remboursé via Whop, puis reporté automatiquement sur la commande Shopify.">
              <RefundForm
                action={refundOrderAction.bind(null, storeId, s.id)}
                totalCents={s.totalCents}
                refundedCents={s.refundedCents}
                currency={s.currency}
                nonce={randomUUID()}
              />
              <details className="group mt-4 border-t border-zinc-100 pt-3 text-sm">
                <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md font-medium text-zinc-700 hover:text-zinc-900 [&::-webkit-details-marker]:hidden">
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Rembourser depuis Whop
                </summary>
                <div className="mt-2 space-y-3 text-zinc-600">
                  <p>
                    Ouvrez{" "}
                    <a href={whopDashboard} target="_blank" rel="noreferrer" className="font-medium text-indigo-600 underline-offset-2 hover:underline">
                      votre dashboard Whop
                    </a>{" "}
                    → <strong>Paiements</strong>, recherchez l&apos;ID ci-dessous, puis <strong>Refund</strong>. Le remboursement sera reporté ici et dans Shopify
                    automatiquement.
                  </p>
                  <CopyField label="ID du paiement Whop" value={s.whopPaymentId} />
                </div>
              </details>
            </Card>
          )}
          {s.status === "PAID" && s.whopPaymentId && remaining <= 0 && (
            <Card icon={RotateCcw} iconColor="#71717a" title="Remboursée intégralement">
              <p className="text-sm text-zinc-600">
                {money(s.refundedCents)} remboursé(s) via Whop. Rien d&apos;autre à faire : Shopify est mis à jour automatiquement.
              </p>
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
      <dt className="shrink-0 text-zinc-500">{k}</dt>
      <dd className="min-w-0 text-right font-medium break-words">{v}</dd>
    </div>
  );
}
