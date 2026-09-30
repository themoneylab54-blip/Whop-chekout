import type { Metadata } from "next";
import { ChevronDown, Layers, PackagePlus, Pencil, Percent, Ticket, Trash2 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { runningTestsByElement } from "@/lib/checkout-tests";
import { tzOf, zonedDay, zoneLabel } from "@/lib/time";
import type { AddOn, DiscountCode } from "@prisma/client";
import { requireStoreAccess } from "@/lib/access";
import { db } from "@/lib/db";
import { loadTheme } from "@/lib/layout";
import { centsToDecimal, parseQuantityTiers } from "@/lib/pricing";
import { QuantityBreaksEditor } from "@/components/dashboard/QuantityBreaksEditor";
import { Badge, Card, EmptyState, Flash, Input, Label, PageHeader, Select, SubmitButton } from "@/components/ui";
import { ConfirmButton } from "@/components/dashboard/ConfirmButton";
import { DirtyForm } from "@/components/dashboard/DirtyForm";
import { CreateCancel, CreateDisclosure } from "@/components/dashboard/CreateDisclosure";
import { AddOnFields } from "@/components/dashboard/AddOnFields";
import { TranslationHint } from "@/components/dashboard/TranslationHint";
import { recordTranslationStatus, translationHintText } from "@/components/dashboard/translationStatus";
import { MoneyInput } from "@/components/dashboard/MoneyInput";
import { AddOnRulesFields } from "@/components/dashboard/AddOnRulesFields";
import { readShowIf, showIfSummary } from "@/components/dashboard/rules";
import { formatCents, formatDate, formatNumber, formatPercent, plural } from "@/components/dashboard/format";
import {
  createAddOnAction,
  createDiscountAction,
  deleteAddOnAction,
  deleteDiscountAction,
  saveQuantityBreaksAction,
  toggleAddOnAction,
  toggleDiscountAction,
  updateAddOnAction,
  updateDiscountAction,
} from "../../../../actions";

export const metadata: Metadata = { title: "Promos & options" };

export default async function OffersPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { storeId } = await params;
  await requireStoreAccess(storeId, "view");
  const sp = await searchParams;
  const store = await db.store.findUnique({
    where: { id: storeId },
    include: { discounts: { orderBy: { createdAt: "desc" } }, addOns: { orderBy: { position: "asc" } } },
  });
  if (!store) notFound();
  // Checkout A/B tests running on an element edited here (the editors say so).
  const running = await runningTestsByElement(store.id);
  const money = (c: number) => formatCents(c, store.shopCurrency);
  const tiers = parseQuantityTiers(store.quantityBreaks);
  const tierCount = tiers.breaks.length + tiers.gifts.length;
  // Base language of the texts typed here (the checkout's default language).
  const baseLang = loadTheme(store.theme, store.name).language;

  return (
    <>
      <PageHeader icon={Percent} iconColor="#ec4899" title="Promos & options" description="Codes promo, remises par quantité et options à ajouter en un clic au checkout pour augmenter le panier moyen." />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <div className="min-w-0 space-y-6">
          <Card icon={Ticket} iconColor="#ec4899" title="Codes promo" description={store.discounts.length ? plural(store.discounts.length, "code") : undefined}>
            {store.discounts.length === 0 ? (
              <EmptyState icon={Ticket} title="Aucun code promo">
                Le champ « Code promo » n&apos;apparaît au checkout que s&apos;il existe au moins un code actif.
              </EmptyState>
            ) : (
              <ul className="-mx-5 divide-y divide-zinc-100 border-t border-zinc-100">
                {store.discounts.map((d) => (
                  <li key={d.id} className="px-5 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-semibold break-all">{d.code}</span>
                          {!d.active && <Badge>Inactif</Badge>}
                        </span>
                        <span className="mt-0.5 block text-xs text-zinc-500">
                          {d.type === "PERCENT" ? `−${formatPercent(d.value / 100)}` : d.type === "FIXED" ? `−${money(d.value)}` : "Livraison offerte"}
                          {d.minSubtotalCents != null && ` · dès ${money(d.minSubtotalCents)}`}
                          {!d.combinesWithBreaks && " · non cumulable avec les remises quantité"}
                          {d.startsAt && ` · dès le ${formatDate(d.startsAt, tzOf(store))}`}
                          {d.endsAt && ` · jusqu'au ${formatDate(d.endsAt, tzOf(store))}`}
                          {` · ${formatNumber(d.usageCount)}${d.usageLimit ? ` / ${formatNumber(d.usageLimit)}` : ""} utilisation${d.usageCount > 1 ? "s" : ""}`}
                        </span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <form action={toggleDiscountAction.bind(null, store.id, d.id)}>
                          <SubmitButton variant="secondary" size="sm" className="min-h-8">
                            {d.active ? "Désactiver" : "Activer"}
                          </SubmitButton>
                        </form>
                        <form action={deleteDiscountAction.bind(null, store.id, d.id)}>
                          <ConfirmButton
                            size="icon"
                            aria-label={`Supprimer le code ${d.code}`}
                            title={`Supprimer le code ${d.code} ?`}
                            description={
                              d.usageCount > 0
                                ? `Il a déjà servi ${formatNumber(d.usageCount)} fois. Les commandes passées ne changent pas, mais le code ne sera plus accepté. Pour le suspendre, préférez « Désactiver ».`
                                : "Le code ne sera plus accepté au checkout. Cette action est définitive."
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          </ConfirmButton>
                        </form>
                      </span>
                    </div>
                    <EditDisclosure
                      key={`${d.code}|${d.type}|${d.value}|${d.minSubtotalCents}|${d.startsAt?.getTime()}|${d.endsAt?.getTime()}|${d.usageLimit}|${d.combinesWithBreaks}`}
                      label={`Modifier le code ${d.code}`}
                    >
                      <DirtyForm label={`Code ${d.code}`} action={updateDiscountAction.bind(null, store.id, d.id)} className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
                        <DiscountFields prefix={`d-${d.id}`} d={d} currency={store.shopCurrency} tz={tzOf(store)} />
                      </DirtyForm>
                    </EditDisclosure>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4">
              <CreateDisclosure label="Ajouter un code promo" title="Nouveau code promo">
                <DirtyForm label="Nouveau code promo" action={createDiscountAction.bind(null, store.id)} className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
                  <DiscountFields prefix="new-discount" currency={store.shopCurrency} tz={tzOf(store)} />
                  <div className="flex flex-wrap gap-2 sm:col-span-2">
                    <SubmitButton>Créer le code</SubmitButton>
                    <CreateCancel />
                  </div>
                </DirtyForm>
              </CreateDisclosure>
            </div>
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          <Card icon={PackagePlus} iconColor="#8b5cf6" title="Options au checkout (order bumps)" description="Affichées par le bloc « Options » du builder, une case à cocher chacune.">
            {store.addOns.length === 0 ? (
              <EmptyState icon={PackagePlus} title="Aucune option">
                Exemples : emballage cadeau, livraison prioritaire, garantie étendue, 2ᵉ produit à prix réduit.
              </EmptyState>
            ) : (
              <ul className="-mx-5 divide-y divide-zinc-100 border-t border-zinc-100">
                {store.addOns.map((a) => (
                  <li key={a.id} data-translations-scope className="px-5 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{a.title}</span>
                          {!a.active && <Badge>Inactif</Badge>}
                          {(() => {
                            const hint = translationHintText(
                              recordTranslationStatus(
                                [
                                  { key: "title", base: a.title },
                                  { key: "description", base: a.description },
                                ],
                                a.i18n,
                                baseLang,
                              ),
                            );
                            return hint ? <TranslationHint text={hint} /> : null;
                          })()}
                        </span>
                        <span className="mt-0.5 block text-xs break-words text-zinc-500">
                          +{money(a.priceCents)}
                          {a.costCents != null && ` · coût ${money(a.costCents)}`}
                          {a.variantId ? " · produit Shopify" : " · frais (sans produit)"}
                          {a.description && ` · ${a.description}`}
                          {a.i18n && typeof a.i18n === "object" && Object.keys(a.i18n).length > 0 && ` · traduit (${Object.keys(a.i18n).join(", ").toUpperCase()})`}
                        </span>
                        {(() => {
                          const rule = showIfSummary(readShowIf(a.showIf), money);
                          return rule ? <span className="mt-1 block text-xs break-words text-indigo-700">{rule}</span> : null;
                        })()}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <form action={toggleAddOnAction.bind(null, store.id, a.id)}>
                          <SubmitButton variant="secondary" size="sm" className="min-h-8">
                            {a.active ? "Désactiver" : "Activer"}
                          </SubmitButton>
                        </form>
                        <form action={deleteAddOnAction.bind(null, store.id, a.id)}>
                          <ConfirmButton
                            size="icon"
                            aria-label={`Supprimer l'option ${a.title}`}
                            title={`Supprimer l'option « ${a.title} » ?`}
                            description="Elle disparaîtra du checkout. Les commandes déjà passées ne changent pas. Pour la retirer temporairement, préférez « Désactiver »."
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          </ConfirmButton>
                        </form>
                      </span>
                    </div>
                    <EditDisclosure
                      key={`${a.title}|${a.description}|${a.priceCents}|${a.costCents}|${a.variantId}|${a.imageUrl}|${JSON.stringify(a.showIf)}|${JSON.stringify(a.i18n)}`}
                      label={`Modifier l'option ${a.title}`}
                    >
                      <DirtyForm label={`Option ${a.title}`} action={updateAddOnAction.bind(null, store.id, a.id)} className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
                        {running.get(`addon:${a.id}`) && (
                          <div className="sm:col-span-2">
                            <TestRunningNotice name={running.get(`addon:${a.id}`)!.name} what="le prix et l'affichage de cette option" storeId={store.id} />
                          </div>
                        )}
                        <AddOnFields prefix={`a-${a.id}`} storeId={store.id} currency={store.shopCurrency} a={addOnValues(a)} baseLang={baseLang} />
                        <AddOnRulesFields prefix={`a-${a.id}`} storeId={store.id} currency={store.shopCurrency} rules={readShowIf(a.showIf)} />
                      </DirtyForm>
                    </EditDisclosure>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4">
              <CreateDisclosure label="Ajouter une option" title="Nouvelle option">
                <DirtyForm label="Nouvelle option" action={createAddOnAction.bind(null, store.id)} className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
                  <AddOnFields prefix="new-addon" storeId={store.id} currency={store.shopCurrency} baseLang={baseLang} />
                  <AddOnRulesFields prefix="new-addon" storeId={store.id} currency={store.shopCurrency} />
                  <div className="flex flex-wrap gap-2 sm:col-span-2">
                    <SubmitButton>Ajouter l&apos;option</SubmitButton>
                    <CreateCancel />
                  </div>
                </DirtyForm>
              </CreateDisclosure>
            </div>
          </Card>
        </div>
      </div>

      <Card
        id="remises"
        className="mt-6"
        icon={Layers}
        iconColor="#ec4899"
        title="Remises par quantité & cadeaux"
        description="Plus le client prend d'articles, plus la remise est forte ; un cadeau peut être offert dès un nombre d'articles ou un montant. Affiché au checkout (« Plus qu'1 article pour −15 % », « Plus que 12 € pour recevoir … »)."
        actions={tierCount ? <Badge color="green">Active</Badge> : <Badge>Inactive</Badge>}
      >
        <DirtyForm label="Remises par quantité" action={saveQuantityBreaksAction.bind(null, store.id)} className="space-y-4">
          {running.get("breaks") && <TestRunningNotice name={running.get("breaks")!.name} what="les paliers de remise" storeId={store.id} />}
          <QuantityBreaksEditor initial={store.quantityBreaks ?? []} storeId={store.id} currency={store.shopCurrency} baseLang={baseLang} />
          <p className="text-xs leading-relaxed text-zinc-500">
            Jusqu&apos;à 5 paliers (2 à 100 articles, remise de 50 % au plus) et 3 cadeaux. Un palier peut ne compter que certains produits : seuls
            ceux-là sont remisés. Le palier atteint le plus avantageux s&apos;applique, puis le code promo sur le reste. Les cadeaux sont ajoutés à 0 € à la
            commande Shopify (prix réel barré au checkout) ; le montant d&apos;un cadeau se calcule sur les articles avant remise.
          </p>
        </DirtyForm>
      </Card>
    </>
  );
}

function EditDisclosure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="group mt-2">
      <summary
        aria-label={label}
        className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50 [&::-webkit-details-marker]:hidden"
      >
        <Pencil className="h-3 w-3" aria-hidden />
        <span className="group-open:hidden">Modifier</span>
        <span className="hidden group-open:inline">Fermer</span>
        <ChevronDown className="h-3 w-3 transition group-open:rotate-180" aria-hidden />
      </summary>
      <div className="mt-3 rounded-xl bg-zinc-50 p-4 ring-1 ring-zinc-900/5">{children}</div>
    </details>
  );
}

/** A checkout A/B test runs on this element: an edit reaches no visitor of the test before it ends. */
function TestRunningNotice({ name, what, storeId }: { name: string; what: string; storeId: string }) {
  return (
    <p role="note" className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-600/20">
      Test A/B « {name} » en cours sur {what} : ses visiteurs gardent la version A de son lancement ou la version B. Une modification ici ne
      s&apos;applique qu&apos;après la fin du test (
      <Link href={`/dashboard/stores/${storeId}/analytics?tab=tests`} className="font-medium underline">
        Tests A/B
      </Link>
      ).
    </p>
  );
}

/** Day "aaaa-mm-jj" of a stored date in the store's time zone, for <input type="date">. */
function isoDay(d: Date, tz: string) {
  return zonedDay(d, tz);
}

function addOnValues(a: AddOn) {
  return {
    title: a.title,
    description: a.description,
    price: centsToDecimal(a.priceCents).replace(".", ","),
    variantId: a.variantId,
    imageUrl: a.imageUrl,
    cost: a.costCents != null ? centsToDecimal(a.costCents).replace(".", ",") : "",
    i18n: a.i18n,
  };
}

function DiscountFields({ prefix, d, currency, tz }: { prefix: string; d?: DiscountCode; currency: string; tz: string }) {
  const id = (k: string) => `${prefix}-${k}`;
  const value = d ? (d.type === "FIXED" ? centsToDecimal(d.value).replace(".", ",") : d.type === "PERCENT" ? String(d.value) : "") : "10";
  return (
    <>
      <div>
        <Label htmlFor={id("code")} hint="Lettres, chiffres, - et _">
          Code
        </Label>
        <Input id={id("code")} name="code" defaultValue={d?.code} placeholder="BIENVENUE10" required maxLength={40} autoComplete="off" className="font-mono uppercase" />
      </div>
      <div>
        <Label htmlFor={id("type")} hint="Ce que le code retire du panier">
          Type
        </Label>
        <Select id={id("type")} name="type" defaultValue={d?.type ?? "PERCENT"}>
          <option value="PERCENT">Pourcentage</option>
          <option value="FIXED">Montant fixe ({currency})</option>
          <option value="FREE_SHIPPING">Livraison offerte</option>
        </Select>
      </div>
      <div>
        <Label htmlFor={id("value")} hint="% ou montant, ignoré pour la livraison offerte">
          Valeur
        </Label>
        <Input id={id("value")} name="value" inputMode="decimal" defaultValue={value} />
      </div>
      <div>
        <Label htmlFor={id("minSubtotal")} hint={`Facultatif, en ${currency}`}>
          Minimum d&apos;achat
        </Label>
        <MoneyInput
          id={id("minSubtotal")}
          name="minSubtotal"
          currency={currency}
          placeholder="ex. 50"
          defaultValue={d?.minSubtotalCents != null ? centsToDecimal(d.minSubtotalCents).replace(".", ",") : ""}
        />
      </div>
      <div>
        <Label htmlFor={id("startsAt")} hint={`Facultatif · dès minuit (${zoneLabel(tz)})`}>
          Valable à partir du
        </Label>
        <Input id={id("startsAt")} name="startsAt" type="date" lang="fr" defaultValue={d?.startsAt ? isoDay(d.startsAt, tz) : ""} />
      </div>
      <div>
        <Label htmlFor={id("endsAt")} hint="Facultatif · valable toute la journée">
          Expire le
        </Label>
        <Input id={id("endsAt")} name="endsAt" type="date" lang="fr" defaultValue={d?.endsAt ? isoDay(d.endsAt, tz) : ""} />
      </div>
      <div>
        <Label htmlFor={id("usageLimit")} hint="Facultatif · vide = illimité">
          Utilisations max.
        </Label>
        <Input id={id("usageLimit")} name="usageLimit" type="number" min={1} inputMode="numeric" defaultValue={d?.usageLimit ?? ""} />
      </div>
      <label htmlFor={id("combinesWithBreaks")} className="flex items-start gap-2 text-sm sm:col-span-2">
        <input id={id("combinesWithBreaks")} type="checkbox" name="combinesWithBreaks" defaultChecked={d?.combinesWithBreaks ?? true} className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600" />
        <span>
          Cumulable avec les remises quantité
          <span className="block text-xs text-zinc-500">Décoché : le client a le code ou la remise quantité, la plus avantageuse des deux (comme Shopify).</span>
        </span>
      </label>
    </>
  );
}
