"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Award,
  BadgeCheck,
  CalendarCheck,
  CreditCard,
  Flame,
  Gauge,
  GripVertical,
  Headphones,
  HelpCircle,
  Image as ImageIcon,
  LayoutGrid,
  Mail,
  MapPin,
  Megaphone,
  MessagesSquare,
  Monitor,
  MousePointerClick,
  Newspaper,
  PackagePlus,
  PlayCircle,
  Quote,
  Scale,
  SeparatorHorizontal,
  Share2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Star,
  StickyNote,
  Ticket,
  Timer,
  TrendingUp,
  Truck,
  Type,
  Wallet,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  Copy,
  Droplets,
  ExternalLink,
  Eye,
  EyeOff,
  Layers,
  Lock,
  Paintbrush,
  Palette,
  PanelBottom,
  PanelsTopLeft,
  PartyPopper,
  Plus,
  RotateCw,
  Search,
  Shapes,
  ShoppingBag,
  Store,
  Trash2,
  Type as TypeIcon,
  X,
  type LucideIcon,
} from "lucide-react";
import { IconTile } from "@/components/icons";
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
import { BlockContentEditor, ColorInput, F, Num, Pick, Segmented, StyleEditor, Text, UrlText } from "./BlockEditor";

export const BLOCK_META: Record<BlockType, { label: string; icon: LucideIcon; description: string; group: "section" | "conversion" | "trust" | "content" | "after" }> = {
  contact: { label: "Contact", icon: Mail, description: "E-mail et opt-in marketing", group: "section" },
  delivery: { label: "Adresse de livraison", icon: MapPin, description: "Formulaire d'adresse", group: "section" },
  shipping_method: { label: "Mode de livraison", icon: Truck, description: "Tarifs de la page Livraison", group: "section" },
  payment: { label: "Paiement", icon: CreditCard, description: "Formulaire Whop et bouton Payer", group: "section" },
  order_addons: { label: "Options (order bumps)", icon: PackagePlus, description: "Cases à cocher d'options payantes", group: "conversion" },
  free_shipping_bar: { label: "Barre livraison offerte", icon: Gauge, description: "Montant restant pour la livraison gratuite", group: "conversion" },
  delivery_estimate: { label: "Date de livraison", icon: CalendarCheck, description: "Estimation et frise commande → livraison", group: "conversion" },
  countdown: { label: "Minuteur", icon: Timer, description: "Compte à rebours jusqu'à une vraie date", group: "conversion" },
  low_stock: { label: "Stock bas", icon: Flame, description: "Basé sur le stock réel Shopify", group: "conversion" },
  announcement: { label: "Barre d'annonce", icon: Megaphone, description: "Bandeau à la couleur de la marque", group: "conversion" },
  order_note: { label: "Note de commande", icon: StickyNote, description: "Message cadeau, instructions…", group: "conversion" },
  secure_badge: { label: "Badge paiement sécurisé", icon: ShieldCheck, description: "Rassure juste avant de payer", group: "trust" },
  reviews: { label: "Avis clients", icon: MessagesSquare, description: "Carrousel ou liste d'avis vérifiés", group: "trust" },
  testimonial: { label: "Témoignage", icon: Quote, description: "Un avis mis en avant", group: "trust" },
  rating: { label: "Note globale", icon: Star, description: "Note moyenne et nombre d'avis", group: "trust" },
  trust_badges: { label: "Badges de confiance", icon: BadgeCheck, description: "Paiement sécurisé, garantie…", group: "trust" },
  guarantee: { label: "Garantie", icon: ShieldCheck, description: "Satisfait ou remboursé", group: "trust" },
  comparison: { label: "Comparatif", icon: Scale, description: "Nous vs les autres", group: "trust" },
  stats: { label: "Chiffres clés", icon: TrendingUp, description: "+10 000 clients, 4,8/5…", group: "trust" },
  logos: { label: "Logos presse", icon: Newspaper, description: "« Ils parlent de nous »", group: "trust" },
  payment_icons: { label: "Logos de paiement", icon: Wallet, description: "Visa, Mastercard, Apple Pay…", group: "trust" },
  benefits: { label: "Avantages", icon: LayoutGrid, description: "Grille d'icônes 3D", group: "content" },
  value_props: { label: "Arguments", icon: Sparkles, description: "3 arguments avec icônes", group: "content" },
  why_us: { label: "Pourquoi nous ?", icon: Award, description: "Lignes avec icônes", group: "content" },
  faq: { label: "FAQ", icon: HelpCircle, description: "Questions fréquentes en accordéon", group: "content" },
  text: { label: "Texte / titre", icon: Type, description: "Titre et paragraphe", group: "content" },
  image: { label: "Image", icon: ImageIcon, description: "Visuel, bannière, GIF", group: "content" },
  video: { label: "Vidéo", icon: PlayCircle, description: "YouTube, Vimeo ou .mp4", group: "content" },
  support: { label: "Support client", icon: Headphones, description: "E-mail, téléphone, WhatsApp", group: "content" },
  spacer: { label: "Espace / séparateur", icon: SeparatorHorizontal, description: "Respiration entre les blocs", group: "content" },
  coupon: { label: "Code promo cadeau", icon: Ticket, description: "Code à copier pour la prochaine commande", group: "after" },
  button_link: { label: "Bouton lien", icon: MousePointerClick, description: "Suivi de commande, communauté…", group: "after" },
  social: { label: "Réseaux sociaux", icon: Share2, description: "Instagram, TikTok, Facebook, YouTube", group: "after" },
};

const GROUP_LABELS = { conversion: "Conversion", trust: "Confiance", content: "Contenu", after: "Après achat" } as const;


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
  const first = useRef(true);

  /* ---------- autosave ---------- */

  // Saves run one after another and always send the latest edits, so a save that
  // finishes late can never overwrite newer changes.
  const [initial] = useState(() => ({ theme: props.theme, layout: props.layout }));
  const latest = useRef(initial);
  const saved = useRef(initial);
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  useEffect(() => {
    latest.current = { theme, layout };
  }, [theme, layout]);

  const { save } = props;
  const doSave = useCallback((): Promise<boolean> => {
    const run = chain.current.then(async () => {
      const snap = latest.current;
      if (snap === saved.current) return true;
      setState("saving");
      try {
        const res = await save(snap.theme, snap.layout);
        if (res.ok) {
          saved.current = snap;
          setState(latest.current === snap ? "saved" : "dirty");
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
    });
    chain.current = run.catch(() => false);
    return run;
  }, [save]);

  // Never lose edits: save right away when leaving the builder or hiding the tab.
  const router = useRouter();
  const pending = state !== "saved";
  async function leaveTo(e: React.MouseEvent, href: string) {
    if (!pending) return;
    e.preventDefault();
    if (await doSave()) router.push(href);
    else if (window.confirm("Certaines modifications n'ont pas pu être enregistrées. Quitter quand même ?")) router.push(href);
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
      if (state !== "saved") e.preventDefault();
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
  const fonts = [fontHref(theme.font), theme.headingFont !== "same" ? fontHref(theme.headingFont) : null].filter(Boolean) as string[];
  const [tab, setTab] = useState<"blocks" | "style">("blocks");
  const [query, setQuery] = useState("");

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
        mode={{ kind: "preview", selectedBlockId: selected, onSelectBlock: (id) => {
          setSelected(id);
          setTab("blocks");
        } }}
      />
    ) : (
      <ThankYouView
        theme={theme}
        layout={layout}
        preview={{ selectedBlockId: selected, onSelectBlock: (id) => {
          setSelected(id);
          setTab("blocks");
        } }}
        data={sampleThankYou(props.currency)}
      />
    );

  const groups = (Object.keys(GROUP_LABELS) as (keyof typeof GROUP_LABELS)[])
    .map((g) => ({
      key: g,
      label: GROUP_LABELS[g],
      types: paletteTypes.filter(
        (t) =>
          BLOCK_META[t].group === g &&
          (!query || `${BLOCK_META[t].label} ${BLOCK_META[t].description}`.toLowerCase().includes(query.toLowerCase())),
      ),
    }))
    .filter((g) => g.types.length > 0);

  return (
    <div className="flex h-screen flex-col bg-[#f6f7f9] text-zinc-900">
      {fonts.map((f) => (
        <link key={f} rel="stylesheet" href={f} />
      ))}

      {/* Top bar */}
      <header className="relative z-20 flex flex-wrap items-center gap-3 border-b border-zinc-200/80 bg-white/80 px-4 py-2.5 backdrop-blur-xl">
        <Link
          href={base}
          onClick={(e) => leaveTo(e, base)}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
        >
          <ArrowLeft className="h-4 w-4" /> {props.storeName}
        </Link>
        <span className="h-5 w-px bg-zinc-200" />
        <nav className="flex rounded-xl bg-zinc-100/80 p-1 text-sm ring-1 ring-zinc-200/60 ring-inset">
          {(
            [
              ["checkout", "Checkout", ShoppingBag],
              ["thank-you", "Remerciement", PartyPopper],
            ] as const
          ).map(([key, label, Icon]) => (
            <Link
              key={key}
              href={`${base}/builder/${key}`}
              onClick={(e) => leaveTo(e, `${base}/builder/${key}`)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1 transition ${
                page === key ? "bg-white font-medium text-zinc-900 shadow-[0_1px_2px_rgba(0,0,0,.08),0_0_0_1px_rgba(0,0,0,.04)]" : "text-zinc-500 hover:text-zinc-800"
              }`}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-xl bg-zinc-100/80 p-1 ring-1 ring-zinc-200/60 ring-inset" role="group" aria-label="Appareil">
            {(
              [
                ["desktop", Monitor, "Ordinateur"],
                ["mobile", Smartphone, "Mobile"],
              ] as const
            ).map(([d, Icon, label]) => (
              <button
                key={d}
                type="button"
                onClick={() => setDevice(d)}
                title={label}
                aria-pressed={device === d}
                className={`rounded-lg p-1.5 transition ${device === d ? "bg-white text-zinc-900 shadow-[0_1px_2px_rgba(0,0,0,.08)]" : "text-zinc-500 hover:text-zinc-800"}`}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
          <SaveStatus state={state} error={error} />
          {state === "error" && (
            <button type="button" onClick={() => window.location.reload()} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm shadow-sm hover:bg-zinc-50">
              <RotateCw className="h-3.5 w-3.5" /> Recharger
            </button>
          )}
          <a
            href={`${base}/preview/${page}`}
            target="_blank"
            rel="noreferrer"
            onClick={() => pending && void doSave()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm shadow-sm transition hover:bg-zinc-50"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Aperçu
          </a>
          <button
            type="button"
            onClick={() => void doSave()}
            disabled={state === "saving" || state === "saved"}
            className="rounded-lg bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white shadow-[0_1px_0_rgba(255,255,255,.15)_inset,0_2px_6px_-2px_rgba(0,0,0,.4)] transition hover:bg-zinc-800 disabled:opacity-40"
          >
            Enregistrer
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Settings column */}
        <aside className="flex w-[372px] shrink-0 flex-col border-r border-zinc-200/80 bg-white">
          <div className="p-3">
            <div className="grid grid-cols-2 rounded-xl bg-zinc-100/80 p-1 text-sm ring-1 ring-zinc-200/60 ring-inset">
              {(
                [
                  ["blocks", "Blocs", Layers],
                  ["style", "Style", Palette],
                ] as const
              ).map(([key, label, Icon]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-lg py-1.5 transition ${
                    tab === key ? "bg-white font-medium shadow-[0_1px_2px_rgba(0,0,0,.08),0_0_0_1px_rgba(0,0,0,.04)]" : "text-zinc-500 hover:text-zinc-800"
                  }`}
                >
                  <Icon className="h-4 w-4" /> {label}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
            {tab === "style" ? (
              <StylePanel theme={theme} setT={setT} page={page} storeName={props.storeName} />
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between px-1">
                  <p className="text-[11px] font-semibold tracking-[.08em] text-zinc-400 uppercase">Blocs de la page</p>
                  <button
                    type="button"
                    onClick={() => setPalette(!palette)}
                    className="inline-flex items-center gap-1 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-zinc-800"
                  >
                    {palette ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />} {palette ? "Fermer" : "Ajouter un bloc"}
                  </button>
                </div>

                {palette && (
                  <div className="mb-3 rounded-2xl border border-zinc-200 bg-zinc-50/70 p-2.5">
                    <div className="relative mb-2">
                      <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                      <input
                        autoFocus
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Rechercher un bloc…"
                        className="w-full rounded-lg border border-zinc-200 bg-white py-1.5 pr-2 pl-8 text-sm outline-none focus:border-zinc-400"
                      />
                    </div>
                    {groups.map((g) => (
                      <div key={g.key} className="mb-2 last:mb-0">
                        <p className="px-1 pt-1 pb-1.5 text-[10px] font-semibold tracking-[.1em] text-zinc-400 uppercase">{g.label}</p>
                        <div className="grid grid-cols-2 gap-1.5">
                          {g.types.map((t) => {
                            const m = BLOCK_META[t];
                            return (
                              <button
                                key={t}
                                type="button"
                                onClick={() => add(t)}
                                className="group flex items-start gap-2 rounded-xl border border-zinc-200 bg-white p-2 text-left shadow-[0_1px_1px_rgba(0,0,0,.03)] transition hover:-translate-y-px hover:border-zinc-300 hover:shadow-md"
                              >
                                <IconTile icon={m.icon} size={28} color="#6366f1" />
                                <span className="min-w-0">
                                  <span className="block text-[13px] leading-tight font-medium">{m.label}</span>
                                  <span className="block text-[11px] leading-snug text-zinc-500">{m.description}</span>
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    {groups.length === 0 && <p className="p-3 text-center text-xs text-zinc-500">Aucun bloc ne correspond.</p>}
                  </div>
                )}

                {page === "checkout" && (
                  <p className="mb-3 px-1 text-[11px] leading-relaxed text-zinc-500">
                    Les sections Contact, Livraison, Mode de livraison et Paiement sont fixes : glissez-les pour les réordonner.
                  </p>
                )}
                {layout.blocks.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-zinc-300 p-6 text-center text-xs text-zinc-500">
                    Aucun bloc supplémentaire. La confirmation, le récapitulatif et l&apos;adresse sont toujours affichés.
                  </div>
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
                            <details className="group rounded-xl border border-zinc-200">
                              <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs font-semibold text-zinc-600">
                                <Paintbrush className="h-3.5 w-3.5" /> Style du bloc
                                <ChevronDown className="ml-auto h-3.5 w-3.5 transition group-open:rotate-180" />
                              </summary>
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
              </>
            )}
          </div>
        </aside>

        {/* Live preview */}
        <main className="relative min-w-0 flex-1 overflow-auto bg-[radial-gradient(circle,#d4d4d8_1px,transparent_1px)] [background-size:18px_18px] p-8">
          <p className="mb-3 flex items-center justify-center gap-1.5 text-[11px] font-medium tracking-wide text-zinc-400">
            <MousePointerClick className="h-3.5 w-3.5" /> Aperçu en direct · cliquez un bloc pour le modifier
          </p>
          <div
            className={`mx-auto overflow-hidden bg-white shadow-[0_24px_60px_-20px_rgba(15,23,42,.25),0_0_0_1px_rgba(15,23,42,.06)] transition-[max-width] duration-300 ${
              device === "mobile" ? "max-w-[400px] rounded-[2.2rem] border-[10px] border-zinc-900" : "max-w-[1200px] rounded-2xl"
            }`}
          >
            {device === "desktop" && (
              <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-2.5">
                <span className="flex gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
                </span>
                <span className="mx-auto flex items-center gap-1.5 rounded-md bg-white px-3 py-0.5 text-[11px] text-zinc-500 ring-1 ring-zinc-200">
                  <Lock className="h-3 w-3" /> {page === "checkout" ? "checkout sécurisé" : "commande confirmée"}
                </span>
              </div>
            )}
            {preview}
          </div>
        </main>
      </div>
    </div>
  );
}

function SaveStatus({ state, error }: { state: SaveState; error: string | null }) {
  const map = {
    saved: ["bg-emerald-500", "Enregistré", "text-zinc-500"],
    dirty: ["bg-amber-400", "Non enregistré", "text-zinc-500"],
    saving: ["bg-sky-500 animate-pulse", "Enregistrement…", "text-zinc-500"],
    error: ["bg-red-500", `Erreur : ${error ?? ""}`, "text-red-600"],
  } as const;
  const [dot, label, color] = map[state];
  return (
    <span className={`inline-flex max-w-[260px] items-center gap-1.5 truncate px-1 text-xs ${color}`} title={error ?? undefined}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function PanelSection({ title, icon: Icon, children, defaultOpen = false }: { title: string; icon: LucideIcon; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group border-b border-zinc-100 last:border-0">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-1 py-3 text-sm font-medium text-zinc-800">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 ring-1 ring-zinc-200/70 ring-inset">
          <Icon className="h-3.5 w-3.5" />
        </span>
        {title}
        <ChevronDown className="ml-auto h-4 w-4 text-zinc-400 transition group-open:rotate-180" />
      </summary>
      <div className="space-y-3.5 px-1 pb-4">{children}</div>
    </details>
  );
}

function StylePanel({
  theme,
  setT,
  page,
  storeName,
}: {
  theme: Theme;
  setT: <K extends keyof Theme>(k: K, v: Theme[K]) => void;
  page: Page;
  storeName: string;
}) {
  const fontOptions = FONTS.map((f) => [f, f] as [typeof f, string]);
  const hex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);
  return (
    <div>
      <PanelSection title="Marque & en-tête" icon={Store} defaultOpen>
        <F label="Nom de la boutique">
          <Text value={theme.storeName} placeholder={storeName} onChange={(v) => setT("storeName", v)} />
        </F>
        <Check label="Afficher le nom dans l'en-tête" checked={theme.showStoreName} onChange={(v) => setT("showStoreName", v)} />
        <F label="Logo (URL)" hint="Astuce : décochez le nom pour un en-tête logo seul.">
          <UrlText value={theme.logoUrl} placeholder="https://…/logo.png" onChange={(v) => setT("logoUrl", v)} />
        </F>
        <div className="grid grid-cols-2 gap-3">
          <F label="Hauteur du logo">
            <Num value={theme.logoHeight} min={16} max={120} onChange={(v) => setT("logoHeight", v)} />
          </F>
          <F label="Alignement">
            <Pick value={theme.headerAlign} options={[["left", "Gauche"], ["center", "Centre"], ["right", "Droite"]]} onChange={(v) => setT("headerAlign", v)} />
          </F>
        </div>
        <F label="Fond de l'en-tête">
          <ColorInput value={theme.headerBackground} allowEmpty={false} onChange={(v) => hex(v) && setT("headerBackground", v)} />
        </F>
        <Check label="Ligne sous l'en-tête" checked={theme.headerBorder} onChange={(v) => setT("headerBorder", v)} />
      </PanelSection>

      <PanelSection title="Couleurs" icon={Droplets}>
        <F label="Couleur principale (boutons)">
          <ColorInput value={theme.accentColor} allowEmpty={false} onChange={(v) => hex(v) && setT("accentColor", v)} />
        </F>
        <F label="2ᵉ couleur (dégradé)" hint="Optionnel : les boutons passent en dégradé.">
          <ColorInput value={theme.accentColor2} onChange={(v) => (v === "" || hex(v)) && setT("accentColor2", v)} />
        </F>
        <F label="Texte">
          <ColorInput value={theme.textColor} allowEmpty={false} onChange={(v) => hex(v) && setT("textColor", v)} />
        </F>
        <F label="Bordures">
          <ColorInput value={theme.borderColor} allowEmpty={false} onChange={(v) => hex(v) && setT("borderColor", v)} />
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
      </PanelSection>

      <PanelSection title="Typographie" icon={TypeIcon}>
        <div className="grid grid-cols-2 gap-3">
          <F label="Police du texte">
            <Pick value={theme.font} options={fontOptions} onChange={(v) => setT("font", v)} />
          </F>
          <F label="Police des titres">
            <Pick value={theme.headingFont} options={[["same", "Identique"], ...fontOptions] as [Theme["headingFont"], string][]} onChange={(v) => setT("headingFont", v)} />
          </F>
        </div>
        <F label="Taille du texte">
          <Segmented value={theme.fontScale} options={[["sm", "Petit"], ["md", "Normal"], ["lg", "Grand"]]} onChange={(v) => setT("fontScale", v)} />
        </F>
        <F label="Langue du checkout">
          <Segmented value={theme.language} options={[["fr", "Français"], ["en", "English"]]} onChange={(v) => setT("language", v)} />
        </F>
      </PanelSection>

      <PanelSection title="Formes & boutons" icon={Shapes}>
        <F label={`Arrondi des coins : ${theme.radius}px`}>
          <input type="range" min={0} max={24} value={theme.radius} onChange={(e) => setT("radius", Number(e.target.value))} className="w-full accent-zinc-900" />
        </F>
        <F label="Forme des boutons">
          <Segmented value={theme.buttonShape} options={[["default", "Arrondi"], ["pill", "Pilule"], ["square", "Carré"]]} onChange={(v) => setT("buttonShape", v)} />
        </F>
        <Check label="Ombre portée sur les boutons" checked={theme.buttonShadow} onChange={(v) => setT("buttonShadow", v)} />
        <F label="Style des champs">
          <Segmented value={theme.inputStyle} options={[["outlined", "Contour"], ["filled", "Rempli"], ["underline", "Souligné"]]} onChange={(v) => setT("inputStyle", v)} />
        </F>
        {page === "checkout" && (
          <>
            <F label="Texte du bouton de paiement" hint="Vide = « Payer maintenant ». Le montant est ajouté automatiquement.">
              <Text value={theme.payButtonText} placeholder="Payer maintenant" onChange={(v) => setT("payButtonText", v)} />
            </F>
            <Check label="Boutons Apple Pay / Google Pay en haut" checked={theme.expressCheckout} onChange={(v) => setT("expressCheckout", v)} />
          </>
        )}
      </PanelSection>

      {page === "checkout" && (
        <PanelSection title="Mise en page" icon={PanelsTopLeft}>
          <F label="Récapitulatif">
            <Segmented value={theme.summarySide} options={[["right", "À droite"], ["left", "À gauche"]]} onChange={(v) => setT("summarySide", v)} />
          </F>
          <F label="Largeur du contenu">
            <Segmented value={theme.contentWidth} options={[["narrow", "Étroite"], ["normal", "Normale"], ["wide", "Large"]]} onChange={(v) => setT("contentWidth", v)} />
          </F>
          <Check label="Images produits dans le récapitulatif" checked={theme.summaryImages} onChange={(v) => setT("summaryImages", v)} />
        </PanelSection>
      )}

      <PanelSection title="Pied de page" icon={PanelBottom}>
        <F label="Ligne de confiance">
          <Text value={theme.trustLine} placeholder="Paiement sécurisé · Livraison suivie" onChange={(v) => setT("trustLine", v)} />
        </F>
        <F label="Liens légaux">
          <div className="space-y-2">
            {theme.policyLinks.map((l, i) => (
              <div key={i} className="flex gap-1.5">
                <Text value={l.label} placeholder="CGV" onChange={(label) => setT("policyLinks", theme.policyLinks.map((x, j) => (j === i ? { ...x, label } : x)))} />
                <Text value={l.url} placeholder="https://…" onChange={(url) => setT("policyLinks", theme.policyLinks.map((x, j) => (j === i ? { ...x, url } : x)))} />
                <button type="button" aria-label="Retirer" className="px-1 text-zinc-400 hover:text-red-600" onClick={() => setT("policyLinks", theme.policyLinks.filter((_, j) => j !== i))}>
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
            {theme.policyLinks.length < 8 && (
              <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline" onClick={() => setT("policyLinks", [...theme.policyLinks, { label: "", url: "" }])}>
                <Plus className="h-3.5 w-3.5" /> Ajouter un lien
              </button>
            )}
          </div>
        </F>
      </PanelSection>
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-xs font-medium text-zinc-700">
      {label}
      <span className="relative inline-flex">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
        <span className="h-5 w-9 rounded-full bg-zinc-300 transition peer-checked:bg-zinc-900 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-400" />
        <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition peer-checked:translate-x-4" />
      </span>
    </label>
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
  const iconBtn = "rounded-md p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`rounded-xl border bg-white transition-shadow ${props.open ? "border-indigo-300 shadow-[0_0_0_3px_rgba(99,102,241,.12)]" : "border-zinc-200 hover:border-zinc-300"} ${isDragging ? "z-10 shadow-xl" : ""}`}
    >
      <div className="flex items-center gap-1 px-1.5 py-1.5">
        <button type="button" {...attributes} {...listeners} className="cursor-grab touch-none rounded-md p-1 text-zinc-300 hover:text-zinc-500 active:cursor-grabbing" aria-label="Déplacer">
          <GripVertical className="h-4 w-4" />
        </button>
        <button type="button" onClick={props.onToggle} className={`flex min-w-0 flex-1 items-center gap-2 text-left text-sm ${block.hidden ? "text-zinc-400 line-through" : ""}`}>
          <IconTile icon={meta.icon} size={26} color={fixed ? "#71717a" : "#6366f1"} />
          <span className="truncate font-medium">{meta.label}</span>
          {fixed && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-zinc-500 uppercase">fixe</span>}
        </button>
        <button type="button" className={iconBtn} onClick={() => props.onMove(-1)} disabled={props.first} aria-label="Monter">
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={iconBtn} onClick={() => props.onMove(1)} disabled={props.last} aria-label="Descendre">
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
        {!fixed && (
          <>
            <button type="button" className={iconBtn} onClick={props.onHide} aria-label={block.hidden ? "Afficher" : "Masquer"} title={block.hidden ? "Afficher" : "Masquer"}>
              {block.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
            {block.type !== "order_addons" && (
              <button type="button" className={iconBtn} onClick={props.onDuplicate} aria-label="Dupliquer" title="Dupliquer">
                <Copy className="h-3.5 w-3.5" />
              </button>
            )}
            <button type="button" className={`${iconBtn} hover:!text-red-600`} onClick={props.onRemove} aria-label="Supprimer" title="Supprimer">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
      {props.open && <div className="border-t border-zinc-100 p-3">{props.children}</div>}
    </li>
  );
}
