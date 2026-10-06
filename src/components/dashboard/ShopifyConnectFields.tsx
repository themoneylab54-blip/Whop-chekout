"use client";

import { useState } from "react";
import { AlertTriangle, Eye, EyeOff, Info } from "lucide-react";
import { Input, Label } from "@/components/ui";
import { clientSecretHint, resolveShopDomainInput, SECRET_MISMATCH_HINT, SECRET_TOO_SHORT } from "@/lib/shopify-connect";

/**
 * Attributes that keep browsers and password managers away from the Client secret: it is a plain
 * text field (masked by CSS), never a password field, so no saved dashboard password is offered or
 * filled into it.
 */
export const SECRET_FIELD_ATTRS = {
  type: "text",
  name: "clientSecret",
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  "data-1p-ignore": "",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
} as const;

/** The form's fields: shop address (storefront domain recognised), Client ID, autofill-proof secret. */
export function ShopifyConnectFields({
  defaultShop,
  knownShopDomain,
  storefrontHost,
  activeClientId,
  defaultClientId,
  hasStoredSecret,
  secretMismatch = false,
}: {
  defaultShop: string;
  knownShopDomain: string | null;
  storefrontHost: string | null;
  activeClientId: string | null;
  /** Prefill: the active Client ID, else the one of an abandoned first attempt. */
  defaultClientId?: string;
  hasStoredSecret: boolean;
  /** The last attempt failed Shopify's signature check: the stored secret is not to be reused. */
  secretMismatch?: boolean;
}) {
  const [shop, setShop] = useState(defaultShop);
  const [clientId, setClientId] = useState(defaultClientId ?? activeClientId ?? "");
  const [secret, setSecret] = useState("");
  const [shown, setShown] = useState(false);
  const domain = shop.trim() ? resolveShopDomainInput(shop, { shopDomain: knownShopDomain, storefrontHost }) : null;
  const sameApp = !!activeClientId && clientId.trim() === activeClientId;
  const reuse = hasStoredSecret && sameApp && !secretMismatch;
  const hint = clientSecretHint(secret);
  // Masked by CSS (-webkit-text-security: Chrome, Safari, Edge, Firefox 128+); elsewhere the text stays readable.
  const masked = !shown;
  const vitrine = storefrontHost ?? "votre-domaine.com";

  return (
    <>
      <div>
        <Label
          htmlFor="shopDomain"
          hint={
            <>
              Gardez l&apos;adresse <strong>xxx.myshopify.com</strong> (Shopify → Paramètres → Domaines) : votre domaine ({vitrine}) est détecté
              automatiquement.
            </>
          }
        >
          Domaine de la boutique
        </Label>
        <Input id="shopDomain" name="shopDomain" placeholder="ma-boutique.myshopify.com" value={shop} onChange={(e) => setShop(e.target.value)} required autoComplete="off" />
        {domain?.ok && domain.notice && (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs text-sky-700" data-testid="shop-notice">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {domain.notice}
          </p>
        )}
        {domain && !domain.ok && (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs text-red-700" data-testid="shop-error">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {domain.error}
          </p>
        )}
      </div>
      <div>
        <Label htmlFor="clientId">Client ID</Label>
        <Input id="clientId" name="clientId" value={clientId} onChange={(e) => setClientId(e.target.value)} required autoComplete="off" spellCheck={false} data-1p-ignore="" data-lpignore="true" />
      </div>
      <div data-no-draft>
        <Label
          htmlFor="clientSecret"
          hint={
            secretMismatch
              ? SECRET_MISMATCH_HINT
              : reuse
                ? "Laissez vide pour garder le secret enregistré de cette app."
                : hasStoredSecret
                  ? "Nouveau Client ID : collez le Client secret de la même app."
                  : "Copiez-le depuis le Dev Dashboard → votre app → Settings."
          }
        >
          Client secret
        </Label>
        <div className="relative">
          <Input
            id="clientSecret"
            {...SECRET_FIELD_ATTRS}
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value);
              const h = clientSecretHint(e.target.value);
              e.target.setCustomValidity(h?.level === "error" ? SECRET_TOO_SHORT : "");
            }}
            required={!reuse}
            placeholder={reuse ? "•••••••• enregistré — laissez vide pour conserver" : "shpss_…"}
            className={`pr-10 font-mono ${masked ? "[-webkit-text-security:disc]" : ""}`}
          />
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-zinc-400 hover:text-zinc-700"
            aria-label={shown ? "Masquer le Client secret" : "Afficher le Client secret"}
            aria-pressed={shown}
          >
            {shown ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
          </button>
        </div>
        {hint && (
          <p className={`mt-1.5 flex items-start gap-1.5 text-xs ${hint.level === "error" ? "text-red-700" : "text-amber-700"}`} data-testid="secret-hint">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {hint.message}
          </p>
        )}
      </div>
    </>
  );
}
