"use client";

import type { Theme } from "@/lib/layout";
import { buttonContrast, buttonGradient, otherButtonColors, payButtonColors, suggestTextColor } from "@/lib/button-colors";
import { ColorInput, Field, Segmented } from "./BlockEditor";
import { RING } from "./ui";

type SetT = <K extends keyof Theme>(k: K, v: Theme[K]) => void;
type ColorKey = "payButtonColor" | "payButtonColor2" | "payButtonTextColor" | "buttonColor" | "buttonTextColor";

const HEX = /^#[0-9a-fA-F]{6}$/;
/** Below this, the builder suggests black or white text (WCAG AA for the button label). */
const MIN_CONTRAST = 4.5;

function ColorRow({ label, hint, k, theme, setT, resetLabel }: { label: string; hint?: string; k: ColorKey; theme: Theme; setT: SetT; resetLabel: string }) {
  const value = theme[k] ?? "";
  return (
    <Field label={label} hint={hint}>
      <ColorInput value={value} onChange={(v) => (v === "" || HEX.test(v)) && setT(k, v)} />
      {value && (
        <button type="button" data-reset={k} onClick={() => setT(k, "")} className={`mt-1 rounded text-[11px] text-zinc-600 underline ${RING}`}>
          {resetLabel}
        </button>
      )}
    </Field>
  );
}

/**
 * Non-blocking hint: the label reads poorly on the button; one click applies black or white.
 * Only once the merchant picked a button or text color: an untouched store gets no advice about
 * colors it never chose (`own`).
 */
function ContrastHint({ bg, bg2, fg, k, own, setT }: { bg: string; bg2: string; fg: string; k: "payButtonTextColor" | "buttonTextColor"; own: boolean; setT: SetT }) {
  if (!own) return null;
  const ratio = buttonContrast(bg, bg2, fg);
  if (!(ratio < MIN_CONTRAST)) return null;
  const better = suggestTextColor(bg, bg2);
  return (
    <p data-contrast-hint={k} className="flex flex-wrap items-center gap-x-2 text-[11px] text-amber-800">
      <span>
        Texte peu lisible sur ce bouton ({ratio.toFixed(1)}:1). Conseillé : texte {better === "#ffffff" ? "blanc" : "noir"}.
      </span>
      <button type="button" onClick={() => setT(k, better)} className={`rounded font-medium underline ${RING}`}>
        Utiliser
      </button>
    </p>
  );
}

function Preview({ label, bg, bg2, fg, shape }: { label: string; bg: string; bg2: string; fg: string; shape: string }) {
  return (
    <span data-preview={label} className="flex min-h-9 flex-1 items-center justify-center px-3 text-xs font-semibold" style={{ backgroundImage: buttonGradient(bg, bg2), color: fg, borderRadius: shape }}>
      {label}
    </span>
  );
}

/**
 * Builder controls of the button colors: the Pay button apart from every other button, each one
 * following the main color until set (« Identique à la couleur principale » resets it).
 */
export function ButtonColorControls({ theme, setT, page }: { theme: Theme; setT: SetT; page: "checkout" | "thank-you" }) {
  const pay = payButtonColors(theme);
  const btn = otherButtonColors(theme);
  const shape = theme.buttonShape === "pill" ? "999px" : theme.buttonShape === "square" ? "0px" : `${Math.min(theme.radius, 12)}px`;
  const reset = "Identique à la couleur principale";
  return (
    <div className="space-y-3" data-button-colors="">
      <div className="flex gap-2" aria-hidden>
        {page === "checkout" && <Preview label="Payer" bg={pay.bg} bg2={pay.bg2} fg={pay.fg} shape={shape} />}
        <Preview label="Ajouter" bg={btn.bg} bg2={btn.bg2} fg={btn.fg} shape={shape} />
      </div>
      {page === "checkout" && (
        <>
          <ColorRow label="Couleur du bouton Payer" hint="Vide : couleur principale. Aussi le bouton « Continuer vers le paiement » sur mobile." k="payButtonColor" theme={theme} setT={setT} resetLabel={reset} />
          {theme.payButtonColor && <ColorRow label="2ᵉ couleur du bouton Payer (dégradé)" k="payButtonColor2" theme={theme} setT={setT} resetLabel="Pas de dégradé" />}
          <ColorRow label="Texte du bouton Payer" hint="Vide : noir ou blanc automatiquement." k="payButtonTextColor" theme={theme} setT={setT} resetLabel="Automatique" />
          <ContrastHint bg={pay.bg} bg2={pay.bg2} fg={pay.fg} k="payButtonTextColor" own={!!(theme.payButtonColor || theme.payButtonTextColor)} setT={setT} />
        </>
      )}
      <ColorRow label="Couleur des autres boutons" hint="Ajouter, offres, bouton lien, Continuer mes achats… Vide : couleur principale." k="buttonColor" theme={theme} setT={setT} resetLabel={reset} />
      <ColorRow label="Texte des autres boutons" hint="Vide : noir ou blanc automatiquement." k="buttonTextColor" theme={theme} setT={setT} resetLabel="Automatique" />
      <ContrastHint bg={btn.bg} bg2={btn.bg2} fg={btn.fg} k="buttonTextColor" own={!!(theme.buttonColor || theme.buttonTextColor)} setT={setT} />
      {page === "checkout" && (
        <Field label="Boutons secondaires (code promo « Appliquer »)">
          <Segmented value={theme.secondaryButtonStyle ?? "outline"} options={[["outline", "Contour"], ["solid", "Plein"]]} onChange={(v) => setT("secondaryButtonStyle", v)} />
        </Field>
      )}
    </div>
  );
}
