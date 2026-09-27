"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CHECKOUT_PALETTE,
  FONTS,
  THANK_YOU_PALETTE,
  createBlock,
  fontHref,
  isFixed,
  newBlockId,
  type Block,
  type BlockType,
  type Layout,
  type Theme,
} from "@/lib/layout";
import type { RateInput } from "@/lib/pricing";
import { SAMPLE_LINES, sampleThankYou } from "@/lib/sample";
import { CheckoutView, type AddOnView } from "@/components/checkout/CheckoutView";
import { ThankYouView } from "@/components/checkout/ThankYouView";
import { BlockContentEditor, ColorInput, F, Num, Pick, Segmented, StyleEditor, Text } from "./BlockEditor";

export const BLOCK_META: Record<BlockType, { label: string; icon: string; description: string }> = {
  contact: { label: "Contact", icon: "✉️", description: "E-mail et opt-in marketing" },
  delivery: { label: "Adresse de livraison", icon: "📦", description: "Formulaire d'adresse" },
  shipping_method: { label: "Mode de livraison", icon: "🚚", description: "Tarifs de la page Livraison" },
  payment: { label: "Paiement", icon: "💳", description: "Formulaire Whop" },
  order_addons: { label: "Options (order bumps)", icon: "➕", description: "Cases à cocher d'options payantes" },
  announcement: { label: "Barre d'annonce", icon: "📣", description: "Bandeau à la couleur de la marque" },
  text: { label: "Texte / titre", icon: "¶", description: "Titre et paragraphe" },
  image: { label: "Image", icon: "🖼️", description: "Visuel, bannière, GIF" },
  testimonial: { label: "Témoignage", icon: "❝", description: "Avis client avec étoiles" },
  rating: { label: "Note globale", icon: "★", description: "Note moyenne et nombre d'avis" },
  trust_badges: { label: "Badges de confiance", icon: "🛡️", description: "Paiement sécurisé, garantie…" },
  guarantee: { label: "Garantie", icon: "✅", description: "Satisfait ou remboursé" },
  faq: { label: "FAQ", icon: "❔", description: "Questions fréquentes en accordéon" },
  value_props: { label: "Arguments", icon: "✨", description: "3 arguments avec icônes" },
  payment_icons: { label: "Logos de paiement", icon: "💳", description: "Visa, Mastercard, Apple Pay…" },
  countdown: { label: "Minuteur", icon: "⏳", description: "Compte à rebours jusqu'à une vraie date" },
  low_stock: { label: "Stock bas", icon: "🔥", description: "Stock réel Shopify" },
  why_us: { label: "Pourquoi nous ?", icon: "🏅", description: "Lignes avec icônes" },
};


type Page = "checkout" | "thank-you";
type SaveState = "saved" | "dirty" | "saving" | "error";
type SaveFn = (theme: Theme, layout: Layout) => Promise<{ ok: true } | { ok: false; error: string }>;

export function BuilderApp(props: {
  storeId: string;
  storeName: string;
  page: Page;
  currency: string;
  theme: Theme;
  layout: Layout;
  rates: RateInput[];
  addOns: AddOnView[];
  hasDiscounts: boolean;
  save: SaveFn;
}) {
  const { page } = props;
  const [theme, setTheme] = useState(props.theme);
  const [layout, setLayout] = useState(props.layout);
  const [selected, setSelected] = useState<string | null>(null);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [state, setState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [panel, setPanel] = useState<"theme" | "header" | null>(null);
  const first = useRef(true);

  /* ---------- autosave ---------- */

  const doSave = useCallback(async (): Promise<boolean> => {
    setState("saving");
    try {
      const res = await props.save(theme, layout);
      if (res.ok) {
        setState("saved");
        setError(null);
        return true;
      }
      setState("error");
      setError(res.error);
    } catch {
      // Network loss, or the page was opened before a new version was deployed.
      setState("error");
      setError("connexion perdue — rechargez la page pour continuer (vos réglages déjà enregistrés sont conservés)");
    }
    return false;
  }, [props, theme, layout]);

  // Never lose edits: save right away when leaving the builder or hiding the tab.
  const router = useRouter();
  const pending = state === "dirty" || state === "error";
  async function leaveTo(e: React.MouseEvent, href: string) {
    if (!pending) return;
    e.preventDefault();
    if (await doSave()) router.push(href);
  }
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden" && pending) void doSave();
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [pending, doSave]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setState("dirty");
    const t = setTimeout(doSave, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, layout]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (state === "dirty" || state === "saving") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state]);

  /* ---------- block operations ---------- */

  const update = (b: Block) => setLayout((l) => ({ blocks: l.blocks.map((x) => (x.id === b.id ? b : x)) }));
  const remove = (id: string) => {
    setLayout((l) => ({ blocks: l.blocks.filter((x) => x.id !== id) }));
    if (selected === id) setSelected(null);
  };
  const duplicate = (b: Block) =>
    setLayout((l) => {
      const i = l.blocks.findIndex((x) => x.id === b.id);
      const copy = { ...structuredClone(b), id: newBlockId() } as Block;
      return { blocks: [...l.blocks.slice(0, i + 1), copy, ...l.blocks.slice(i + 1)] };
    });
  const move = (id: string, dir: -1 | 1) =>
    setLayout((l) => {
      const i = l.blocks.findIndex((x) => x.id === id);
      const j = i + dir;
      if (j < 0 || j >= l.blocks.length) return l;
      return { blocks: arrayMove(l.blocks, i, j) };
    });
  const add = (type: BlockType) => {
    const block = createBlock(type);
    setLayout((l) => {
      // New checkout blocks go just before Payment; thank-you blocks at the end.
      const payIndex = l.blocks.findIndex((b) => b.type === "payment");
      const at = page === "checkout" && payIndex >= 0 ? payIndex : l.blocks.length;
      return { blocks: [...l.blocks.slice(0, at), block, ...l.blocks.slice(at)] };
    });
    setSelected(block.id);
    setPalette(false);
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    setLayout((l) => {
      const from = l.blocks.findIndex((b) => b.id === e.active.id);
      const to = l.blocks.findIndex((b) => b.id === e.over!.id);
      return { blocks: arrayMove(l.blocks, from, to) };
    });
  }

  const setT = <K extends keyof Theme>(k: K, v: Theme[K]) => setTheme((t) => ({ ...t, [k]: v }));
  const base = `/dashboard/stores/${props.storeId}`;
  const paletteTypes = (page === "checkout" ? CHECKOUT_PALETTE : THANK_YOU_PALETTE).filter(
    (t) => t !== "order_addons" || !layout.blocks.some((b) => b.type === "order_addons"),
  );
  const font = fontHref(theme.font);

  const preview =
    page === "checkout" ? (
      <CheckoutView
        theme={theme}
        layout={layout}
        currency={props.currency}
        lines={SAMPLE_LINES}
        rates={props.rates}
        addOns={props.addOns}
        hasDiscounts={props.hasDiscounts}
        mode={{ kind: "preview", selectedBlockId: selected, onSelectBlock: setSelected }}
      />
    ) : (
      <ThankYouView
        theme={theme}
        layout={layout}
        preview={{ selectedBlockId: selected, onSelectBlock: setSelected }}
        data={sampleThankYou(props.currency)}
      />
    );

  return (
    <div className="flex h-screen flex-col bg-zinc-100">
      {font && <link rel="stylesheet" href={font} />}
      {/* Top bar */}
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-4 py-2.5">
        <Link href={base} onClick={(e) => leaveTo(e, base)} className="text-sm text-zinc-500 hover:text-zinc-900">
          ← {props.storeName}
        </Link>
        <nav className="ml-2 flex rounded-lg bg-zinc-100 p-0.5 text-sm">
          <Link href={`${base}/builder/checkout`} onClick={(e) => leaveTo(e, `${base}/builder/checkout`)} className={`rounded-md px-3 py-1 ${page === "checkout" ? "bg-white font-medium shadow-sm" : "text-zinc-600"}`}>
            Checkout
          </Link>
          <Link href={`${base}/builder/thank-you`} onClick={(e) => leaveTo(e, `${base}/builder/thank-you`)} className={`rounded-md px-3 py-1 ${page === "thank-you" ? "bg-white font-medium shadow-sm" : "text-zinc-600"}`}>
            Page de remerciement
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex rounded-lg bg-zinc-100 p-0.5 text-sm" role="group" aria-label="Appareil">
            {(["desktop", "mobile"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDevice(d)}
                className={`rounded-md px-3 py-1 ${device === d ? "bg-white font-medium shadow-sm" : "text-zinc-600"}`}
              >
                {d === "desktop" ? "🖥 Ordinateur" : "📱 Mobile"}
              </button>
            ))}
          </div>
          <span className={`text-xs ${state === "error" ? "text-red-600" : state === "saved" ? "text-emerald-600" : "text-zinc-500"}`} title={error ?? undefined}>
            {state === "saved" && "✓ Enregistré"}
            {state === "dirty" && "Modifications non enregistrées"}
            {state === "saving" && "Enregistrement…"}
            {state === "error" && `Erreur : ${error}`}
          </span>
          {state === "error" && (
            <button type="button" onClick={() => window.location.reload()} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm">
              Recharger
            </button>
          )}
          <a
            href={`${base}/preview/${page}`}
            target="_blank"
            rel="noreferrer"
            onClick={() => pending && void doSave()}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50"
          >
            Aperçu plein écran ↗
          </a>
          <button type="button" onClick={() => void doSave()} disabled={state === "saving" || state === "saved"} className="rounded-lg bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40">
            Enregistrer
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Settings column */}
        <aside className="w-[360px] shrink-0 overflow-y-auto border-r border-zinc-200 bg-white">
          <Collapsible title="🎨 Thème & textes" open={panel === "theme"} onToggle={() => setPanel(panel === "theme" ? null : "theme")}>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <F label="Langue">
                  <Pick value={theme.language} options={[["fr", "Français"], ["en", "English"]]} onChange={(v) => setT("language", v)} />
                </F>
                <F label="Police">
                  <Pick value={theme.font} options={FONTS.map((f) => [f, f] as [typeof f, string])} onChange={(v) => setT("font", v)} />
                </F>
              </div>
              <F label={`Arrondi des coins : ${theme.radius}px`}>
                <input type="range" min={0} max={24} value={theme.radius} onChange={(e) => setT("radius", Number(e.target.value))} className="w-full" />
              </F>
              <F label="Couleur principale (boutons)">
                <ColorInput value={theme.accentColor} allowEmpty={false} onChange={(v) => /^#[0-9a-fA-F]{6}$/.test(v) ? setT("accentColor", v) : null} />
              </F>
              <F label="Fond de page">
                <ColorInput value={theme.pageBackground} onChange={(v) => setT("pageBackground", v)} />
              </F>
              {page === "checkout" && (
                <>
                  <F label="Fond colonne formulaire">
                    <ColorInput value={theme.formBackground} onChange={(v) => setT("formBackground", v)} />
                  </F>
                  <F label="Fond colonne récapitulatif">
                    <ColorInput value={theme.summaryBackground} onChange={(v) => setT("summaryBackground", v)} />
                  </F>
                </>
              )}
              {page === "checkout" && (
                <>
                  <label className="flex items-center gap-2 text-xs font-medium text-zinc-700">
                    <input type="checkbox" checked={theme.expressCheckout} onChange={(e) => setT("expressCheckout", e.target.checked)} />
                    Boutons Apple Pay / Google Pay en haut du checkout
                  </label>
                  <F label="Texte du bouton de paiement" hint="Vide = « Payer maintenant ». Le montant est ajouté automatiquement.">
                    <Text value={theme.payButtonText} placeholder="Payer maintenant" onChange={(v) => setT("payButtonText", v)} />
                  </F>
                </>
              )}
              <F label="Ligne de confiance (pied de page)">
                <Text value={theme.trustLine} placeholder="Paiement sécurisé · Livraison suivie" onChange={(v) => setT("trustLine", v)} />
              </F>
              <F label="Liens légaux (pied de page)">
                <div className="space-y-2">
                  {theme.policyLinks.map((l, i) => (
                    <div key={i} className="flex gap-1.5">
                      <Text value={l.label} placeholder="CGV" onChange={(label) => setT("policyLinks", theme.policyLinks.map((x, j) => (j === i ? { ...x, label } : x)))} />
                      <Text value={l.url} placeholder="https://…" onChange={(url) => setT("policyLinks", theme.policyLinks.map((x, j) => (j === i ? { ...x, url } : x)))} />
                      <button type="button" className="text-zinc-400 hover:text-red-600" onClick={() => setT("policyLinks", theme.policyLinks.filter((_, j) => j !== i))}>
                        ✕
                      </button>
                    </div>
                  ))}
                  {theme.policyLinks.length < 8 && (
                    <button type="button" className="text-xs font-medium underline" onClick={() => setT("policyLinks", [...theme.policyLinks, { label: "", url: "" }])}>
                      + Ajouter un lien
                    </button>
                  )}
                </div>
              </F>
            </div>
          </Collapsible>

          <Collapsible title="🏷️ En-tête (logo & nom)" open={panel === "header"} onToggle={() => setPanel(panel === "header" ? null : "header")}>
            <div className="space-y-3">
              <p className="text-[11px] text-zinc-500">Partagé entre le checkout et la page de remerciement.</p>
              <F label="Nom de la boutique">
                <Text value={theme.storeName} placeholder={props.storeName} onChange={(v) => setT("storeName", v)} />
              </F>
              <label className="flex items-center gap-2 text-xs font-medium text-zinc-700">
                <input type="checkbox" checked={theme.showStoreName} onChange={(e) => setT("showStoreName", e.target.checked)} /> Afficher le nom dans l&apos;en-tête
              </label>
              <F label="Alignement">
                <Segmented value={theme.headerAlign} options={[["left", "Gauche"], ["center", "Centre"], ["right", "Droite"]]} onChange={(v) => setT("headerAlign", v)} />
              </F>
              <F label="Logo (URL)" hint="Astuce : décochez le nom pour un en-tête logo seul.">
                <Text value={theme.logoUrl} placeholder="https://…/logo.png" onChange={(v) => setT("logoUrl", v)} />
              </F>
              <F label="Hauteur du logo (px)">
                <Num value={theme.logoHeight} min={16} max={120} onChange={(v) => setT("logoHeight", v)} />
              </F>
            </div>
          </Collapsible>

          <div className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Blocs</p>
              <button type="button" onClick={() => setPalette(!palette)} className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white">
                + Ajouter un bloc
              </button>
            </div>
            {page === "checkout" && (
              <p className="mb-3 text-[11px] text-zinc-500">
                Contact, Livraison, Mode de livraison et Paiement sont fixes : glissez-les pour les réordonner. Placez avis, badges et minuteur au-dessus ou en dessous du paiement.
              </p>
            )}
            {palette && (
              <div className="mb-3 grid grid-cols-2 gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 p-2">
                {paletteTypes.map((t) => (
                  <button key={t} type="button" onClick={() => add(t)} className="rounded-md border border-zinc-200 bg-white p-2 text-left hover:border-zinc-900">
                    <span className="block text-sm">
                      {BLOCK_META[t].icon} {BLOCK_META[t].label}
                    </span>
                    <span className="block text-[11px] text-zinc-500">{BLOCK_META[t].description}</span>
                  </button>
                ))}
              </div>
            )}
            {layout.blocks.length === 0 && (
              <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-500">
                Aucun bloc supplémentaire. La confirmation, le récapitulatif et l&apos;adresse sont toujours affichés.
              </p>
            )}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={layout.blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
                <ul className="space-y-1.5">
                  {layout.blocks.map((b, i) => (
                    <SortableRow
                      key={b.id}
                      block={b}
                      open={selected === b.id}
                      first={i === 0}
                      last={i === layout.blocks.length - 1}
                      onToggle={() => setSelected(selected === b.id ? null : b.id)}
                      onHide={() => update({ ...b, hidden: !b.hidden })}
                      onDuplicate={() => duplicate(b)}
                      onRemove={() => remove(b.id)}
                      onMove={(d) => move(b.id, d)}
                    >
                      <div className="space-y-4">
                        <BlockContentEditor block={b} onChange={update} />
                        {page === "checkout" && !isFixed(b.type) && b.type !== "order_addons" && (
                          <F label="Emplacement">
                            <Segmented value={b.placement} options={[["form", "Colonne formulaire"], ["summary", "Récapitulatif"]]} onChange={(placement) => update({ ...b, placement })} />
                          </F>
                        )}
                        {page === "thank-you" && (
                          <F label="Position">
                            <Segmented value={b.position} options={[["above", "Au-dessus du récap"], ["below", "En dessous"]]} onChange={(position) => update({ ...b, position })} />
                          </F>
                        )}
                        <details className="rounded-md border border-zinc-200">
                          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-zinc-600">🎨 Style</summary>
                          <div className="border-t border-zinc-200 p-3">
                            <StyleEditor style={b.style} onChange={(style) => update({ ...b, style })} />
                          </div>
                        </details>
                      </div>
                    </SortableRow>
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          </div>
        </aside>

        {/* Live preview */}
        <main className="min-w-0 flex-1 overflow-auto p-6">
          <p className="mb-2 text-center text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">
            Aperçu en direct · données d&apos;exemple · cliquez un bloc pour le modifier
          </p>
          <div
            className={`mx-auto overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm transition-[max-width] ${device === "mobile" ? "max-w-[390px]" : "max-w-[1200px]"}`}
          >
            {preview}
          </div>
        </main>
      </div>
    </div>
  );
}

function Collapsible({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="border-b border-zinc-200">
      <button type="button" onClick={onToggle} className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-zinc-50" aria-expanded={open}>
        {title}
        <span className="text-zinc-400">{open ? "▴" : "▾"}</span>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

function SortableRow(props: {
  block: Block;
  open: boolean;
  first: boolean;
  last: boolean;
  onToggle: () => void;
  onHide: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onMove: (d: -1 | 1) => void;
  children: ReactNode;
}) {
  const { block } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id });
  const fixed = isFixed(block.type);
  const meta = BLOCK_META[block.type];
  const iconBtn = "rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`rounded-lg border bg-white ${props.open ? "border-zinc-900 ring-2 ring-zinc-900/10" : "border-zinc-200"} ${isDragging ? "z-10 shadow-lg" : ""}`}
    >
      <div className="flex items-center gap-1 px-1.5 py-1.5">
        <button type="button" {...attributes} {...listeners} className="cursor-grab touch-none px-1 text-zinc-400 active:cursor-grabbing" aria-label="Déplacer">
          ⠿
        </button>
        <button type="button" onClick={props.onToggle} className={`min-w-0 flex-1 truncate text-left text-sm ${block.hidden ? "text-zinc-400 line-through" : ""}`}>
          {meta.icon} {meta.label}
          {fixed && <span className="ml-1.5 text-[10px] font-medium text-zinc-400 uppercase">fixe</span>}
        </button>
        <button type="button" className={iconBtn} onClick={() => props.onMove(-1)} disabled={props.first} aria-label="Monter">
          ↑
        </button>
        <button type="button" className={iconBtn} onClick={() => props.onMove(1)} disabled={props.last} aria-label="Descendre">
          ↓
        </button>
        {!fixed && (
          <>
            <button type="button" className={iconBtn} onClick={props.onHide} aria-label={block.hidden ? "Afficher" : "Masquer"} title={block.hidden ? "Afficher" : "Masquer"}>
              {block.hidden ? "🙈" : "👁"}
            </button>
            <button type="button" className={iconBtn} onClick={props.onDuplicate} aria-label="Dupliquer" title="Dupliquer">
              ⧉
            </button>
            <button type="button" className={`${iconBtn} hover:text-red-600`} onClick={props.onRemove} aria-label="Supprimer" title="Supprimer">
              ✕
            </button>
          </>
        )}
      </div>
      {props.open && <div className="border-t border-zinc-100 p-3">{props.children}</div>}
    </li>
  );
}
