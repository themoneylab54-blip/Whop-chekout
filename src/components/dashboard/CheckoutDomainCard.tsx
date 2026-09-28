import { Globe } from "lucide-react";
import type { Store } from "@prisma/client";
import { Badge, Card, Input, Label, SubmitButton } from "@/components/ui";
import { DirtyForm } from "@/components/dashboard/DirtyForm";
import { CopyField } from "@/components/dashboard/CopyField";
import { formatDateTime } from "@/components/dashboard/format";
import { APEX_WARNING, CNAME_TARGET, cnameName, domainStatus } from "@/lib/checkout-domain";

/** Vercel's anycast address for an apex domain (a CNAME is not allowed at the root of a zone). */
const VERCEL_APEX_IP = "76.76.21.21";

const BADGE_COLOR = { none: "zinc", pending: "amber", verified: "green", error: "red" } as const;

/**
 * "Domaine du checkout" (Réglages): the store's own checkout hostname, the DNS record to add in
 * plain French, its verification status and the "Vérifier" button.
 */
export function CheckoutDomainCard({
  store,
  appHost,
  vercelAuto,
  timeZone,
  saveAction,
  verifyAction,
}: {
  store: Pick<Store, "checkoutDomain" | "checkoutDomainVerifiedAt" | "checkoutDomainError" | "checkoutDomainCheckedAt">;
  appHost: string;
  vercelAuto: boolean;
  timeZone: string;
  saveAction: (fd: FormData) => Promise<void>;
  verifyAction: () => Promise<void>;
}) {
  const status = domainStatus(store);
  const domain = store.checkoutDomain;
  const name = domain ? cnameName(domain) : "checkout";
  const apex = name === "@";
  return (
    <Card
      icon={Globe}
      iconColor="#0891b2"
      title="Domaine du checkout"
      description={`Vos clients paient sur votre propre adresse (par exemple checkout.maboutique.com) au lieu de ${appHost}.`}
      actions={<Badge color={BADGE_COLOR[status.status]}>{status.label}</Badge>}
    >
      <DirtyForm label="Domaine du checkout" action={saveAction} className="space-y-3">
        <div>
          <Label
            htmlFor="checkoutDomain"
            hint={`Un sous-domaine de votre site (checkout.maboutique.com) ou de votre domaine d'opérateur (maboutique.mondomaine.com). Laissez vide pour garder ${appHost}.`}
          >
            Domaine du checkout
          </Label>
          <Input
            id="checkoutDomain"
            name="checkoutDomain"
            defaultValue={domain ?? ""}
            placeholder="checkout.maboutique.com"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="url"
            maxLength={253}
          />
        </div>
        {/* A root domain (maboutique.com) is refused without this box: its record would move the main site. */}
        <label className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-900 ring-1 ring-red-600/20">
          <input type="checkbox" name="confirmApex" defaultChecked={apex} className="mt-0.5 h-4 w-4 shrink-0 accent-red-600" />
          <span>
            <strong>Domaine racine uniquement (maboutique.com, sans sous-domaine) :</strong> {APEX_WARNING} Cochez pour confirmer. Inutile pour un sous-domaine (checkout.maboutique.com).
          </span>
        </label>
      </DirtyForm>

      {status.status === "verified" && (
        <p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-600/20">
          Vos clients paient sur <strong>https://{domain}</strong>. Dernière vérification le {formatDateTime(store.checkoutDomainVerifiedAt!, false, timeZone)} (revérifié toutes les heures).
        </p>
      )}
      {status.message && (
        <p
          role={status.status === "error" ? "alert" : undefined}
          className={`mt-4 rounded-lg px-3 py-2 text-sm ring-1 ${status.status === "error" ? "bg-red-50 text-red-900 ring-red-600/20" : "bg-amber-50 text-amber-900 ring-amber-600/20"}`}
        >
          {status.message}
          {store.checkoutDomainCheckedAt && <span className="mt-0.5 block text-xs opacity-80">Vérifié le {formatDateTime(store.checkoutDomainCheckedAt, false, timeZone)}.</span>}
        </p>
      )}

      <div className="mt-5 border-t border-zinc-100 pt-4">
        <h3 className="mb-2 text-[13px] font-semibold text-zinc-800">{domain ? "Mise en place" : "Comment ça marche ?"}</h3>
        <ol className="list-decimal space-y-2.5 pl-5 text-sm text-zinc-700">
          <li>
            {apex ? (
              <>
                Chez votre hébergeur de nom de domaine (OVH, GoDaddy, Ionos, Cloudflare…), ajoutez un enregistrement <strong>A</strong> : nom <code className="rounded bg-zinc-100 px-1">@</code> → valeur{" "}
                <code className="rounded bg-zinc-100 px-1">{VERCEL_APEX_IP}</code>. Un sous-domaine (checkout.…) est plus simple et ne touche pas à votre site.
              </>
            ) : (
              <>
                Chez votre hébergeur de nom de domaine (OVH, GoDaddy, Ionos, Cloudflare…), ajoutez un enregistrement <strong>CNAME</strong> : nom{" "}
                <code className="rounded bg-zinc-100 px-1">{name}</code> {domain ? "" : "(ou le sous-domaine choisi) "}→ valeur <code className="rounded bg-zinc-100 px-1">{CNAME_TARGET}</code>
              </>
            )}
            {domain && (
              <div className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
                <CopyField label={apex ? "Nom (A)" : "Nom (CNAME)"} value={name} />
                <CopyField label="Valeur" value={apex ? VERCEL_APEX_IP : CNAME_TARGET} />
              </div>
            )}
            {domain && name === domain && (
              <span className="mt-1 block text-xs text-zinc-500">
                Si votre hébergeur ajoute lui-même votre nom de domaine à la fin du nom, saisissez seulement la partie qui précède votre domaine (par exemple « checkout »).
              </span>
            )}
            <span className="mt-1 block text-xs text-zinc-500">Sur Cloudflare, laissez le nuage gris (« DNS only »).</span>
          </li>
          <li>
            {vercelAuto ? (
              <>Le domaine est ajouté automatiquement au projet Vercel à l&apos;enregistrement : rien à faire de ce côté.</>
            ) : (
              <>
                Ajoutez aussi ce domaine dans <strong>Vercel → Settings → Domains</strong> (projet du checkout).
              </>
            )}
          </li>
          <li>
            Cliquez sur <strong>Vérifier</strong>. Le DNS met quelques minutes à quelques heures à se propager ; le certificat HTTPS est créé tout seul ensuite. On revérifie aussi
            automatiquement.
          </li>
        </ol>
        {domain && (
          <form action={verifyAction} className="mt-4">
            <SubmitButton variant="secondary">Vérifier</SubmitButton>
          </form>
        )}
      </div>
    </Card>
  );
}
