import type { Metadata } from "next";
import { ChevronDown, House, MapPin, Pencil, Trash2, Truck } from "lucide-react";
import { SecretInput } from "@/components/dashboard/SecretInput";
import { OwnerBoundInput } from "@/components/dashboard/OwnerBoundInput";
import { ownerBoundLocked } from "@/lib/owner-bound";
import { CountryMultiSelect } from "@/components/dashboard/CountryMultiSelect";
import { countriesSummary } from "@/components/dashboard/countries";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DirtyForm } from "@/components/dashboard/DirtyForm";
import { CreateCancel, CreateDisclosure } from "@/components/dashboard/CreateDisclosure";
import { requireStoreAccess, roleCan } from "@/lib/access";
import { db } from "@/lib/db";
import { loadTheme } from "@/lib/layout";
import type { Lang } from "@/components/checkout/i18n";
import { RecordTranslationsEditor } from "@/components/dashboard/RecordTranslations";
import { TranslationHint } from "@/components/dashboard/TranslationHint";
import { recordTranslationStatus, translationHintText } from "@/components/dashboard/translationStatus";
import { localizeDeliveryTime } from "@/components/checkout/localize";
import { centsToDecimal } from "@/lib/pricing";
import { pickupConfigured } from "@/lib/pickup";
import { MoneyInput } from "@/components/dashboard/MoneyInput";
import { RateKindField } from "@/components/dashboard/RateKindField";
import { ConfirmButton } from "@/components/dashboard/ConfirmButton";
import { formatCents } from "@/components/dashboard/format";
import { Badge, Card, EmptyState, Flash, Input, Label, PageHeader, SubmitButton } from "@/components/ui";
import { deleteRateAction, savePickupAction, saveRateAction, testPickupAction } from "../../../../actions";

export const metadata: Metadata = { title: "Livraison" };

export default async function ShippingPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { storeId } = await params;
  const { user } = await requireStoreAccess(storeId, "view");
  const sp = await searchParams;
  const store = await db.store.findUnique({ where: { id: storeId }, include: { shippingRates: { orderBy: { position: "asc" } } } });
  if (!store) notFound();
  const money = (c: number) => formatCents(c, store.shopCurrency);
  const baseLang = loadTheme(store.theme, store.name).language;
  const pickupReady = pickupConfigured(store);
  const settingsHref = "#point-relais";
  const pickupRates = store.shippingRates.filter((r) => r.kind === "pickup" && r.active).length;
  const pickupWithoutSetup = !pickupReady && store.shippingRates.some((r) => r.kind === "pickup" && r.active);

  return (
    <>
      <PageHeader
        icon={Truck}
        iconColor="#0ea5e9"
        title="Livraison"
        description="Les pays livrés et leurs tarifs. Le coût s'ajoute au montant encaissé par Whop et apparaît sur la commande Shopify."
      />
      <Flash ok={sp.ok} error={sp.error} />
      {pickupWithoutSetup && (
        <p role="alert" className="mb-6 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-600/20">
          Un tarif « Point relais » est actif mais Mondial Relay n&apos;est pas configuré : vos clients ne pourront pas choisir de point.{" "}
          <Link href={settingsHref} className="font-medium underline">
            Configurer Mondial Relay
          </Link>
        </p>
      )}

      <Card
        id="point-relais"
        icon={MapPin}
        iconColor="#0ea5e9"
        title="Point relais (Mondial Relay)"
        description="Vos clients choisissent un point relais au checkout ; il devient l'adresse de livraison de la commande Shopify."
        actions={pickupReady ? <Badge color="green">Configuré</Badge> : <Badge>Non configuré</Badge>}
        className="mb-8"
      >
        <DirtyForm label="Point relais" action={savePickupAction.bind(null, store.id)} className="space-y-4">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="mondialRelayEnseigne" hint="Fourni par Mondial Relay (ex. BDTEST13 en test)">
                Code enseigne
              </Label>
              <OwnerBoundInput
                locked={ownerBoundLocked(user.role, !!store.mondialRelayKey)}
                id="mondialRelayEnseigne"
                name="mondialRelayEnseigne"
                defaultValue={store.mondialRelayEnseigne ?? ""}
                placeholder="BDTEST13"
                autoComplete="off"
                maxLength={10}
                className="font-mono uppercase"
              />
            </div>
            <div>
              <Label htmlFor="mondialRelayKey" hint={store.mondialRelayKey ? "Configurée ✓ · saisissez une clé pour la remplacer" : "Clé privée de l'espace Mondial Relay (chiffrée)"}>
                Clé privée
              </Label>
              <SecretInput name="mondialRelayKey" stored={!!store.mondialRelayKey} placeholder="PrivateK" locked={!roleCan(user.role, "owner")} />
            </div>
          </div>
        </DirtyForm>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-zinc-100 pt-3">
          <form action={testPickupAction.bind(null, store.id)}>
            <SubmitButton size="sm" variant="secondary" disabled={!pickupReady} title={pickupReady ? undefined : "Enregistrez d'abord le code enseigne et la clé"}>
              Tester la connexion
            </SubmitButton>
          </form>
          <p className="min-w-0 flex-1 basis-60 text-xs leading-relaxed text-zinc-500">
            Cherche les points relais autour de Paris 2ᵉ (75002) avec les identifiants enregistrés.{" "}
            {pickupRates
              ? `${pickupRates} tarif${pickupRates > 1 ? "s" : ""} « Point relais » actif${pickupRates > 1 ? "s" : ""} ci-dessous.`
              : "Pour le proposer, ajoutez ci-dessous un tarif de type « Point relais »."}
          </p>
        </div>
      </Card>

      <h2 className="mb-3 text-[15px] font-semibold tracking-tight text-zinc-900">Tarifs de livraison</h2>
      <div className="space-y-4">
        {store.shippingRates.map((r) => (
          <Card key={r.id}>
            <details data-translations-scope className="group">
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg [&::-webkit-details-marker]:hidden">
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium">{r.name}</span>
                    {r.kind === "pickup" ? (
                      <Badge color="blue" dot={false}>
                        <MapPin className="h-3 w-3" aria-hidden /> Point relais
                      </Badge>
                    ) : (
                      <Badge color="zinc" dot={false}>
                        <House className="h-3 w-3" aria-hidden /> Domicile
                      </Badge>
                    )}
                    {r.deliveryTime && <span className="text-sm text-zinc-500">{r.deliveryTime}</span>}
                    {(() => {
                      const hint = translationHintText(
                        recordTranslationStatus(
                          [
                            { key: "name", base: r.name },
                            { key: "deliveryTime", base: r.deliveryTime, auto: localizeDeliveryTime },
                          ],
                          r.i18n,
                          baseLang,
                        ),
                      );
                      if (hint) return <TranslationHint as="span" text={hint} />;
                      return r.i18n && typeof r.i18n === "object" && Object.keys(r.i18n).length > 0 ? (
                        <Badge color="blue" dot={false}>
                          Traduit : {Object.keys(r.i18n).join(", ").toUpperCase()}
                        </Badge>
                      ) : null;
                    })()}
                  </span>
                  <span className="mt-0.5 block text-xs text-zinc-500">
                    {countriesSummary(r.countries)}
                    {r.freeOverCents != null && ` · offert dès ${money(r.freeOverCents)}`}
                    {r.costCents != null && ` · vous coûte ${money(r.costCents)}`}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  {!r.active && <Badge>Inactif</Badge>}
                  <span className="font-semibold tabular-nums">{r.priceCents ? money(r.priceCents) : "Offert"}</span>
                  <span className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-sm font-medium text-indigo-600 group-hover:bg-indigo-50">
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                    <span className="group-open:hidden">Modifier</span>
                    <span className="hidden group-open:inline">Fermer</span>
                    <ChevronDown className="h-3.5 w-3.5 transition group-open:rotate-180" aria-hidden />
                  </span>
                </span>
              </summary>
              <div className="mt-4 border-t border-zinc-100 pt-4">
                <RateForm storeId={store.id} rate={r} currency={store.shopCurrency} pickupReady={pickupReady} settingsHref={settingsHref} baseLang={baseLang} />
                <form action={deleteRateAction.bind(null, store.id, r.id)} className="mt-4 border-t border-zinc-100 pt-4">
                  <ConfirmButton
                    size="sm"
                    title={`Supprimer le tarif « ${r.name} » ?`}
                    description={
                      store.shippingRates.filter((x) => x.active).length <= 1 && r.active
                        ? "C'est votre seul tarif actif : sans tarif, le checkout ne pourra plus livrer les produits physiques."
                        : "Il ne sera plus proposé au checkout. Cette action est définitive."
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden /> Supprimer ce tarif
                  </ConfirmButton>
                </form>
              </div>
            </details>
          </Card>
        ))}
        {store.shippingRates.length === 0 && (
          <div className="rounded-2xl bg-white shadow-[var(--shadow-card)]">
            <EmptyState icon={Truck} title="Aucun tarif de livraison">
              Ajoutez-en au moins un : sans tarif, le checkout ne peut pas livrer les produits physiques.
            </EmptyState>
          </div>
        )}
        <CreateDisclosure label="Ajouter un tarif" title="Nouveau tarif">
          <RateForm storeId={store.id} currency={store.shopCurrency} pickupReady={pickupReady} settingsHref={settingsHref} baseLang={baseLang} />
        </CreateDisclosure>
      </div>
    </>
  );
}

function RateForm({
  storeId,
  rate,
  currency,
  pickupReady,
  settingsHref,
  baseLang,
}: {
  baseLang: Lang;
  storeId: string;
  rate?: {
    id: string;
    name: string;
    deliveryTime: string | null;
    countries: string[];
    priceCents: number;
    freeOverCents: number | null;
    costCents: number | null;
    kind: string;
    active: boolean;
    i18n?: unknown;
  };
  currency: string;
  pickupReady: boolean;
  settingsHref: string;
}) {
  const id = (k: string) => `${rate ? `rate-${rate.id}` : "new-rate"}-${k}`;
  return (
    <DirtyForm label={rate ? `Tarif ${rate.name}` : "Nouveau tarif"} action={saveRateAction.bind(null, storeId)} className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
      {rate && <input type="hidden" name="id" value={rate.id} />}
      <div>
        <Label htmlFor={id("name")}>Nom</Label>
        <Input id={id("name")} name="name" defaultValue={rate?.name ?? "Standard"} required maxLength={80} />
      </div>
      <div>
        <Label htmlFor={id("deliveryTime")} hint="Affiché au client sous le nom du tarif">
          Délai affiché
        </Label>
        <Input id={id("deliveryTime")} name="deliveryTime" defaultValue={rate?.deliveryTime ?? "3 à 5 jours ouvrés"} maxLength={80} />
      </div>
      <RateKindField id={id("kind")} defaultValue={rate?.kind === "pickup" ? "pickup" : "home"} pickupReady={pickupReady} settingsHref={settingsHref} />
      <div>
        <Label htmlFor={id("price")} hint="Payé par le client · 0 = livraison offerte">
          Prix
        </Label>
        <MoneyInput id={id("price")} name="price" currency={currency} defaultValue={rate ? centsToDecimal(rate.priceCents).replace(".", ",") : "0,00"} required />
      </div>
      <div>
        <Label htmlFor={id("cost")} hint="Facultatif · ce que le transporteur vous facture, pour l'analyse des marges">
          Coût réel pour vous
        </Label>
        <MoneyInput id={id("cost")} name="cost" currency={currency} placeholder="ex. 4,90" defaultValue={rate?.costCents != null ? centsToDecimal(rate.costCents).replace(".", ",") : ""} />
      </div>
      <div>
        <Label htmlFor={id("freeOver")} hint="Facultatif : à partir de ce sous-total, la livraison devient gratuite">
          Offert dès (sous-total)
        </Label>
        <MoneyInput
          id={id("freeOver")}
          name="freeOver"
          currency={currency}
          placeholder="ex. 60"
          defaultValue={rate?.freeOverCents != null ? centsToDecimal(rate.freeOverCents).replace(".", ",") : ""}
        />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor={id("countries")} hint="Aucun pays sélectionné = livraison dans tous les pays.">
          Pays livrés
        </Label>
        <CountryMultiSelect id={id("countries")} name="countries" defaultValue={rate?.countries ?? []} />
      </div>
      <label htmlFor={id("active")} className="flex min-h-9 items-center gap-2 text-sm">
        <input id={id("active")} type="checkbox" name="active" defaultChecked={rate?.active ?? true} className="h-4 w-4 accent-indigo-600" /> Proposé au checkout
      </label>
      <div className="sm:col-span-2">
        <RecordTranslationsEditor
          fields={[
            { key: "name", label: "Nom", base: rate?.name ?? "Standard" },
            { key: "deliveryTime", label: "Délai affiché", base: rate?.deliveryTime ?? "3 à 5 jours ouvrés", auto: "deliveryTime" },
          ]}
          initial={rate?.i18n}
          baseLang={baseLang}
        />
      </div>
      {!rate && (
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <SubmitButton>Ajouter le tarif</SubmitButton>
          <CreateCancel />
        </div>
      )}
    </DirtyForm>
  );
}
