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
  Languages,
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
  MessageSquareHeart,
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
  ArrowRight,
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Droplets,
  ExternalLink,
  Eye,
  EyeOff,
  FlaskConical,
  Hand,
  Keyboard,
  Layers,
  LayoutTemplate,
  Lock,
  MoreHorizontal,
  Paintbrush,
  Palette,
  PanelBottom,
  PanelLeft,
  PanelsTopLeft,
  PartyPopper,
  Plus,
  RotateCcw,
  RotateCw,
  Search,
  Shapes,
  ShoppingBag,
  ShoppingBasket,
  Store,
  Trash2,
  Type as TypeIcon,
  X,
  type LucideIcon,
  Rocket,
  History,
  Undo2,
  Redo2,
  CloudAlert,
  CloudCheck,
  LoaderCircle,
  Zap,
  CircleCheckBig,
  Receipt,
  Home as HomeIcon,
  Info,
  ListPlus,
  TriangleAlert,
  ClipboardList,
  PackageCheck,
} from "lucide-react";
import { IconTile } from "@/components/icons";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type DragOverEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CHECKOUT_PALETTE,
  FONTS,
  SINGLETON_BLOCKS,
  THANK_YOU_PALETTE,
  clearUrl,
  createBlock,
  fontHref,
  headerModeOf,
  isFixedSection,
  newBlockId,
  signedWithStore,
  DEFAULT_EXPRESS_METHODS,
  MESSAGE_LIMITS,
  expressMethodsAllOff,
  expressMethodsCartDependent,
  type Block,
  type BlockType,
  type ExpressMethods,
  type Layout,
  type Theme,
} from "@/lib/layout";
import { formatMoney, type CartLine, type RateInput } from "@/lib/pricing";
import { COMPACT_BEFORE_PAY_MAX, CheckoutView, belowPaymentReason, checkoutZones, isReassuranceWidget, zoneWithPlacement, type AddOnView, type CheckoutZone } from "@/components/checkout/CheckoutView";
import { ThankYouView } from "@/components/checkout/ThankYouView";
import { LANGS } from "@/components/checkout/i18n";
import { BlockContentEditor, ColorInput, F, Field, ImageField, Pick, Segmented, StyleEditor, Text, UrlText, type EditorContext, type ImageSource } from "./BlockEditor";
import { MediaLibraryProvider } from "./media";
import { CanvasOverlays, type DropHint, type InlineEditing } from "./CanvasOverlays";
import { hideVisibleSamples, tagDuplicate, visibleSampleIds } from "@/lib/sample-content";
import { applyTemplateTheme, blocksHiddenBy, blocksKeptAside, canonicalTemplateId, CHECKOUT_TEMPLATES, matchingCheckout, matchingThankYou, previewAfterPopover, TEMPLATE_CATEGORIES, THANK_YOU_TEMPLATES, type Template, type TemplateCategory } from "./templates";
import { TranslationsEditor, untranslatedCount } from "./Translations";
import { emptyTextDefault } from "@/components/checkout/localize";
import { readableOn } from "@/lib/contrast";
import { EmptyState, Panel, PanelHeading, RING, Tip, useConfirm, useOutsideClick, useRelativeTime } from "./ui";
import { BlockThumb, TemplateThumb } from "./thumbs";
import {
  expressRowState,
  hiddenFromBuyers,
  logosInPaymentHeader,
  insertedZone,
  insertionHint,
  insertionIndex,
  layoutWarnings,
  promiseWarnings,
  renderedInsertionHint,
  reviewNotes,
  sampleWarnings,
  setupWarnings,
  zoneLabel,
  zoneWording,
} from "./placement";
import { describeLayoutDiff, describeThemeDiff, diffLayout, diffTheme } from "./changes";

export const BLOCK_META: Record<BlockType, { label: string; icon: LucideIcon; description: string; group: "section" | "conversion" | "trust" | "content" | "after" }> = {
  express: { label: "Paiement express", icon: Zap, description: "Apple Pay, Google Pay, Whop Pay, PayPal en un clic", group: "section" },
  ty_confirmation: { label: "Confirmation", icon: CircleCheckBig, description: "Merci, numéro de commande et suivi", group: "section" },
  ty_details: { label: "Adresse & livraison", icon: HomeIcon, description: "Adresse, livraison estimée, paiement", group: "section" },
  ty_summary: { label: "Récapitulatif", icon: Receipt, description: "Articles et total payé", group: "section" },
  contact: { label: "Contact", icon: Mail, description: "E-mail et opt-in marketing", group: "section" },
  delivery: { label: "Adresse de livraison", icon: MapPin, description: "Formulaire d'adresse", group: "section" },
  shipping_method: { label: "Mode de livraison", icon: Truck, description: "Tarifs de la page Livraison", group: "section" },
  payment: { label: "Paiement", icon: CreditCard, description: "Formulaire Whop et bouton Payer", group: "section" },
  order_addons: { label: "Options (order bumps)", icon: PackagePlus, description: "Cases à cocher d'options payantes", group: "conversion" },
  recommendations: { label: "Complétez votre commande", icon: ShoppingBasket, description: "1 à 4 produits ajoutés au panier en un clic", group: "conversion" },
  free_shipping_bar: { label: "Barre livraison offerte", icon: Gauge, description: "Montant restant pour la livraison gratuite", group: "conversion" },
  delivery_estimate: { label: "Date de livraison", icon: CalendarCheck, description: "Estimation et frise commande → livraison", group: "conversion" },
  countdown: { label: "Minuteur", icon: Timer, description: "Compte à rebours jusqu'à une vraie date", group: "conversion" },
  low_stock: { label: "Stock bas", icon: Flame, description: "Basé sur le stock réel Shopify", group: "conversion" },
  announcement: { label: "Barre d'annonce", icon: Megaphone, description: "Bandeau à la couleur de la marque", group: "conversion" },
  order_note: { label: "Note de commande", icon: StickyNote, description: "Message cadeau, instructions…", group: "conversion" },
  secure_badge: { label: "Badge paiement sécurisé", icon: ShieldCheck, description: "Rassure juste avant de payer", group: "trust" },
  reviews: { label: "Avis clients", icon: MessagesSquare, description: "Vos vrais avis : import CSV (Judge.me, Loox…) ou saisie", group: "trust" },
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
  upsell: { label: "Offre post-achat 1 clic", icon: Rocket, description: "Ajout au colis sans ressaisir la carte", group: "conversion" },
  coupon: { label: "Code promo cadeau", icon: Ticket, description: "Code à copier pour la prochaine commande", group: "after" },
  shipping_protection: { label: "Protection colis", icon: PackageCheck, description: "Option payante perte, vol, casse", group: "conversion" },
  survey: { label: "Sondage « Comment nous avez-vous connu ? »", icon: ClipboardList, description: "Attribution en un clic, par commande", group: "after" },
  button_link: { label: "Bouton lien", icon: MousePointerClick, description: "Suivi de commande, communauté…", group: "after" },
  social: { label: "Réseaux sociaux", icon: Share2, description: "Instagram, TikTok, Facebook, YouTube", group: "after" },
  message: { label: "Message personnalisé", icon: MessageSquareHeart, description: "Mot du fondateur : photo, texte et signature", group: "after" },
};


const GROUP_LABELS = { conversion: "Conversion", trust: "Confiance", content: "Contenu", after: "Après achat" } as const;

/** Case- and accent-insensitive search text. */
const norm = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * Palette rows for features that are settings, not blocks: found by search, they lead to the
 * dashboard page where they are configured ("Remises quantité → Promos & options").
 */
const PALETTE_POINTERS: { key: string; label: string; target: string; path: string; description: string; keywords: string; icon: LucideIcon }[] = [
  {
    key: "breaks",
    label: "Remises quantité",
    target: "Promos & options",
    path: "offers",
    description: "Paliers « 2 achetés −10 % », cadeaux : réglés sur la page Promos & options, affichés dans le récapitulatif.",
    keywords: "remise quantite palier volume lot bundle cadeau offert",
    icon: TrendingUp,
  },
  {
    key: "codes",
    label: "Codes promo",
    target: "Promos & options",
    path: "offers",
    description: "Créés sur la page Promos & options ; le champ code s'affiche seul dans le récapitulatif.",
    keywords: "code promo coupon reduction remise discount",
    icon: Ticket,
  },
  {
    key: "shipping",
    label: "Livraison",
    target: "Livraison",
    path: "shipping",
    description: "Tarifs, pays et point relais : réglés sur la page Livraison, le choix s'affiche au checkout.",
    keywords: "livraison frais de port expedition tarif transporteur relais mondial colissimo shipping",
    icon: Truck,
  },
];

/** Blocks that can only appear once per page. */
function isSingleton(type: BlockType) {
  return SINGLETON_BLOCKS.has(type) || type === "order_addons";
}

type Page = "checkout" | "thank-you";
type SaveState = "saved" | "dirty" | "saving" | "error";
/** `draft`: the saved design differs from the published one (false once edits are undone). */
/** `other`: the other page's layout, sent only when it changed (a matching template applied to both pages). */
type SaveFn = (theme: Theme, layout: Layout, other?: Layout) => Promise<{ ok: true; draft?: boolean } | { ok: false; error: string }>;
type Version = { id: string; label: string; createdAt: string; current: boolean };
type Popover = "menu" | "versions" | "templates" | "publish" | "ab" | null;
type Toast = {
  message: string;
  /** `while`: the action is offered only while the page is still exactly this design (e.g. undoing a template). */
  action?: { label: string; run: () => void; while?: { theme: Theme; layout: Layout } };
  duration?: number;
  /** Move keyboard focus to the action once shown (the button that triggered it is gone). */
  focusAction?: boolean;
} | null;

const noopSubscribe = () => () => {};

const EXPRESS_HINT_KEY = "wc-builder-express-hint";
let hintDismissedFallback = false;
function subscribeHint(cb: () => void) {
  window.addEventListener(EXPRESS_HINT_KEY, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EXPRESS_HINT_KEY, cb);
    window.removeEventListener("storage", cb);
  };
}
function readHintDismissed() {
  try {
    return hintDismissedFallback || localStorage.getItem(EXPRESS_HINT_KEY) === "1";
  } catch {
    return hintDismissedFallback;
  }
}
/** "⌘" on Apple devices, "Ctrl" elsewhere (server render assumes ⌘). */
function useModKey() {
  return useSyncExternalStore(
    noopSubscribe,
    () => (/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl "),
    () => "⌘",
  );
}

/** "Playfair Display + Lato": the fonts a styled template sets. */
function styleFonts(t: Template): string {
  if (!t.style) return "";
  return t.style.headingFont !== "same" && t.style.headingFont !== t.style.font ? `${t.style.headingFont} + ${t.style.font}` : t.style.font;
}

function defaultVersionName() {
  return `Version du ${new Date().toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

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
  /** Cart shown in the preview: the store's latest real cart when there is one. */
  sampleLines: CartLine[];
  realSample: boolean;
  thankYouData: React.ComponentProps<typeof ThankYouView>["data"];
  /** Images the merchant can pick in image fields (product photos, logo…). */
  images: ImageSource[];
  save: SaveFn;
  /** The builder edits a draft; buyers see the last published design. */
  hasDraft: boolean;
  draftUpdatedAt: string | null;
  publishedAt: string | null;
  versions: Version[];
  publish: (label: string) => Promise<{ ok: true; stripped?: number } | { ok: false; error: string }>;
  restore: (versionId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  discard: () => Promise<{ ok: true }>;
  /** Published design (null when never published), to summarise what "Publier" changes. */
  published: { theme: Theme; checkoutLayout: Layout; thankYouLayout: Layout } | null;
  /** Draft of the other page (checkout ↔ thank-you): publishing covers both. */
  otherLayout: Layout;
  /** Block to open on load (link from the other page's publish checklist). */
  initialSelected?: string | null;
  /** Store online (enabled, Shopify and Whop connected): else a published design isn't seen by buyers yet. */
  storeLive?: boolean;
  /** Name of the checkout A/B test running on the shipping protection price, if any. */
  protectionTest?: string | null;
}) {
  const { page } = props;
  const router = useRouter();
  const mod = useModKey();
  const [unpublished, setUnpublished] = useState(props.hasDraft);
  const [publishedAt, setPublishedAt] = useState(props.publishedAt);
  const [publishing, setPublishing] = useState(false);
  const [versionName, setVersionName] = useState("");
  const [popover, setPopover] = useState<Popover>(null);
  const [theme, setTheme] = useState(props.theme);
  const [layout, setLayout] = useState(props.layout);
  // The other page's draft: only changed here by a template applied with its matching page.
  const [otherLayout, setOtherLayout] = useState(props.otherLayout);
  const [selected, setSelected] = useState<string | null>(() =>
    props.initialSelected && props.layout.blocks.some((b) => b.id === props.initialSelected) ? props.initialSelected : null,
  );
  // Library item under the pointer / keyboard focus: the canvas marker shows where *it* lands.
  const [hoverType, setHoverType] = useState<BlockType | null>(null);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  // Canvas language (preview only, never saved): shows the "Traductions" of each block.
  // null = the store's language, followed when it changes in Style.
  const [previewLangPick, setPreviewLang] = useState<Theme["language"] | null>(null);
  const [state, setState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  // Where "Ajouter un bloc" inserts: after this block id, or null = default spot.
  const [insertAfter, setInsertAfter] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<DropHint>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const paletteTrigger = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"blocks" | "style">("blocks");
  const [query, setQuery] = useState("");
  // Keyboard highlight in the block library (index in the filtered, flattened list).
  const [activeIdx, setActiveIdx] = useState(0);
  const [mobileView, setMobileView] = useState<"panel" | "canvas">("canvas");
  const [interact, setInteract] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [confirmDialog, ask] = useConfirm();
  const leaving = useRef(false);
  const panelScroll = useRef<HTMLDivElement>(null);
  const previewRoot = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const [menuFocus, setMenuFocus] = useState<"first" | "last">("first");
  const popoverTriggers = useRef<HTMLDivElement>(null);

  // Hover or keyboard focus on the toast pauses its countdown (restarted when left).
  const [toastHeld, setToastHeld] = useState(false);
  const showToast = useCallback((t: Toast) => {
    setToastHeld(false); // a toast closed under the pointer never leaves the next one paused
    setToast(t);
  }, []);
  useEffect(() => {
    if (!toast || toastHeld) return;
    const t = setTimeout(() => setToast(null), toast.duration ?? (toast.action ? 9000 : 3000));
    return () => clearTimeout(t);
  }, [toast, toastHeld]);
  const toastAction = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (toast?.focusAction) toastAction.current?.focus();
  }, [toast]);

  /* ---------- autosave ---------- */

  // Saves run one after another and always send the latest edits, so a save that
  // finishes late can never overwrite newer changes.
  const [initial] = useState(() => ({ theme: props.theme, layout: props.layout, other: props.otherLayout }));
  const latest = useRef(initial);
  const saved = useRef(initial);
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  useEffect(() => {
    latest.current = { theme, layout, other: otherLayout };
  }, [theme, layout, otherLayout]);
  // Name a new message block is signed with: the store name of the design, else the store's (event handlers only).
  const storeLabel = () => latest.current.theme.storeName.trim() || props.storeName;

  const { save, storeId } = props;
  const doSave = useCallback((): Promise<boolean> => {
    const run = chain.current.then(async () => {
      const snap = latest.current;
      if (snap === saved.current) return true;
      setState("saving");
      try {
        const res = await save(snap.theme, snap.layout, snap.other !== saved.current.other ? snap.other : undefined);
        if (res.ok) {
          saved.current = snap;
          setState(latest.current === snap ? "saved" : "dirty");
          setError(null);
          // The server knows whether the draft still differs from the live design.
          setUnpublished(res.draft ?? true);
          try {
            // Edited in this tab session: coming back to it later is no "restore".
            if (res.draft ?? true) sessionStorage.setItem(`wc-builder-draft-session:${storeId}`, "1");
          } catch {
            /* storage blocked */
          }
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
  }, [save, storeId]);

  // Never lose edits: save right away when leaving the builder or hiding the tab.
  const pending = state !== "saved";
  async function leaveTo(e: React.MouseEvent, href: string) {
    if (!pending) return;
    e.preventDefault();
    if (await doSave()) router.push(href);
    else if (
      await ask({
        title: "Quitter sans enregistrer ?",
        body: "Certaines modifications n'ont pas pu être enregistrées et seront perdues.",
        confirm: "Quitter quand même",
        danger: true,
      })
    )
      router.push(href);
  }
  /** Same as leaveTo, from the keyboard (palette pointer rows). */
  async function leaveFor(href: string) {
    if (pending && !(await doSave())) {
      const ok = await ask({
        title: "Quitter sans enregistrer ?",
        body: "Certaines modifications n'ont pas pu être enregistrées et seront perdues.",
        confirm: "Quitter quand même",
        danger: true,
      });
      if (!ok) return;
    }
    router.push(href);
  }
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden" && pending) void doSave();
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [pending, doSave]);

  useEffect(() => {
    // Nothing changed since the last save (first render, React dev double effects, undo back).
    if (theme === saved.current.theme && layout === saved.current.layout && otherLayout === saved.current.other) {
      setState((s) => (s === "dirty" ? "saved" : s));
      return;
    }
    // Only the banner's measured proportions filled in (a design saved before they were measured):
    // not an edit, so no autosave when the builder opens. `saved` stays behind `latest`, so the next
    // save (a real edit, or publish's doSave) still writes the ratio.
    if (layout === saved.current.layout && otherLayout === saved.current.other && saved.current.theme.bannerRatio == null && onlyBannerRatioChanged(saved.current.theme, theme)) {
      setState((s) => (s === "dirty" ? "saved" : s));
      return;
    }
    setState("dirty");
    const t = setTimeout(doSave, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, layout, otherLayout]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (state !== "saved" && !leaving.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state]);

  /* ---------- undo / redo ---------- */

  /** `other`: the other page's layout (a template applied with its matching page is one step). */
  type Snap = { theme: Theme; layout: Layout; other: Layout };
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  const prevSnap = useRef<Snap>(initial);
  const lastPush = useRef(0);
  // Set by a step that must stay alone (a template): the next edit, however quick, starts a new step.
  const sealStep = useRef(false);
  const applying = useRef(false);
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 });
  useEffect(() => {
    const current = { theme, layout, other: otherLayout };
    if (applying.current) {
      applying.current = false;
    } else if (current.layout === prevSnap.current.layout && onlyBannerRatioChanged(prevSnap.current.theme, current.theme)) {
      // The banner's proportions, measured after its image loaded: part of the step that set the
      // image (never a step of their own, or undo would restore the ratio and the measure redo it).
    } else if (current.theme !== prevSnap.current.theme || current.layout !== prevSnap.current.layout || current.other !== prevSnap.current.other) {
      // Typing in one field is a single undo step (changes closer than 600 ms are merged).
      if (Date.now() - lastPush.current > 600) {
        past.current.push(prevSnap.current);
        if (past.current.length > 100) past.current.shift();
      }
      lastPush.current = sealStep.current ? Date.now() - 601 : Date.now();
      sealStep.current = false;
      future.current = [];
    }
    prevSnap.current = current;
    setHistoryDepth({ undo: past.current.length, redo: future.current.length });
  }, [theme, layout, otherLayout]);

  const travel = useCallback((dir: "undo" | "redo") => {
    const from = dir === "undo" ? past.current : future.current;
    const to = dir === "undo" ? future.current : past.current;
    const target = from.pop();
    if (!target) return;
    to.push(prevSnap.current);
    applying.current = true;
    lastPush.current = 0;
    setTheme(target.theme);
    setLayout(target.layout);
    setOtherLayout(target.other);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const el = e.target as HTMLElement | null;
      // Inside a text field, keep the browser's own undo.
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        travel("undo");
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        travel("redo");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [travel]);

  /* ---------- Escape closes the top-most layer ---------- */

  const escState = useRef({ popover, palette, selected });
  useEffect(() => {
    escState.current = { popover, palette, selected };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const s = escState.current;
      if (s.popover) {
        setPopover(null);
      } else if (s.palette) {
        setPalette(false);
        setQuery("");
      } else if (s.selected) {
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
        setSelected(null);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useOutsideClick(popover != null, () => setPopover(null), [popoverRef, popoverTriggers]);
  useOutsideClick(palette, () => {
    setPalette(false);
    setQuery("");
  }, [paletteRef, paletteTrigger]);
  const togglePopover = (p: Exclude<Popover, null>) => {
    setPopover((cur) => (cur === p ? null : p));
    if (p === "publish") {
      setVersionName(defaultVersionName());
    }
  };

  /* ---------- publish / history ---------- */

  async function publish() {
    setPublishing(true);
    try {
      if (!(await doSave())) throw new Error("Enregistrement impossible : corrigez l'erreur puis réessayez.");
      const res = await props.publish(versionName.trim() || defaultVersionName());
      if (!res.ok) throw new Error(res.error);
      // Deleted images were emptied on publish: reload the published design, or the next autosave
      // would write their addresses back into the draft.
      if (res.stripped) {
        try {
          // Shown once the page is back (the toast wouldn't survive the reload).
          sessionStorage.setItem(`wc-builder-flash:${storeId}`, String(res.stripped));
        } catch {
          /* storage blocked: reload without the notice */
        }
        leaving.current = true;
        window.location.reload();
        return;
      }
      setUnpublished(false);
      setPublishedAt(new Date().toISOString());
      setPopover(null);
      showToast({ message: "Publié : vos clients voient ce design." });
      router.refresh();
    } catch (err) {
      showToast({ message: err instanceof Error ? err.message : "Erreur lors de la publication" });
    } finally {
      setPublishing(false);
    }
  }
  async function reloadAfter(fn: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    await doSave();
    const res = await fn();
    if (!res.ok) {
      showToast({ message: res.error });
      return;
    }
    leaving.current = true;
    window.location.reload();
  }
  async function restoreVersion(v: Version) {
    setPopover(null);
    const ok = await ask({
      title: `Restaurer « ${v.label} » ?`,
      body: (
        <>
          Cette version remplace votre brouillon actuel (checkout et remerciement). Rien n&apos;est mis en ligne tant que vous ne cliquez pas sur{" "}
          <strong>Publier</strong>.
        </>
      ),
      confirm: "Restaurer",
    });
    if (ok) await reloadAfter(() => props.restore(v.id));
  }
  async function discardDraft() {
    setPopover(null);
    const ok = await ask({
      title: "Abandonner le brouillon ?",
      body: "Toutes les modifications non publiées (checkout et remerciement) seront perdues et le design publié sera rechargé.",
      confirm: "Abandonner",
      danger: true,
    });
    if (ok) await reloadAfter(props.discard);
  }

  // Opening the builder on an unpublished draft: say so once per draft. The key holds the
  // draft's save date when it was announced (or first edited here) and is cleared once the
  // draft is published / discarded, so the next draft is announced again. Informational only:
  // discarding stays in "Plus d'actions" / "Versions", behind a confirmation.
  // A draft only counts as "restored" when it comes back from an earlier browsing session
  // (or another device): a draft edited in this tab session (sessionStorage mark) is just the
  // merchant's work in progress, and blocked storage shows nothing rather than every time.
  const draftKey = `wc-builder-draft-toast:${props.storeId}`;
  const draftSessionKey = `wc-builder-draft-session:${props.storeId}`;
  useEffect(() => {
    try {
      if (!unpublished) sessionStorage.removeItem(draftSessionKey);
      else if (!props.hasDraft || sessionStorage.getItem(draftSessionKey)) sessionStorage.setItem(draftSessionKey, "1");
    } catch {
      /* storage blocked */
    }
    // A draft started here needs no announcement; a published / discarded one resets the key.
    if (props.hasDraft && unpublished) return;
    try {
      if (!unpublished) localStorage.removeItem(draftKey);
      else if (!localStorage.getItem(draftKey)) localStorage.setItem(draftKey, new Date().toISOString());
    } catch {
      /* storage blocked */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unpublished]);
  useEffect(() => {
    if (!props.hasDraft || !props.draftUpdatedAt) return;
    const t = setTimeout(() => {
      try {
        // Edited in this tab session: nothing was restored, the merchant just came back.
        if (sessionStorage.getItem(draftSessionKey)) return;
        // Any stored stamp = this draft was already announced (or started in this browser).
        if (localStorage.getItem(draftKey)) return;
        localStorage.setItem(draftKey, props.draftUpdatedAt ?? new Date().toISOString());
      } catch {
        return; /* storage blocked: can't tell a restore from a revisit, stay quiet */
      }
      showToast({
        message: "Brouillon restauré : vos modifications non publiées sont de retour.",
        action: { label: "Voir les versions", run: () => setPopover("versions") },
        duration: 8000,
      });
    }, 300);
    return () => clearTimeout(t);
    // Mount only: the draft state at load time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A publish that emptied deleted images reloaded the page: say so once it is back.
  useEffect(() => {
    const key = `wc-builder-flash:${props.storeId}`;
    let n = 0;
    try {
      n = Number(sessionStorage.getItem(key)) || 0;
    } catch {
      return;
    }
    if (n <= 0) return;
    // Consumed when shown (not on read): React's dev double effect would otherwise lose it.
    const t = setTimeout(() => {
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* storage blocked */
      }
      showToast({
        message: `Publié : ${n === 1 ? "1 image supprimée retirée" : `${n} images supprimées retirées`} de la page publiée.`,
        duration: 7000,
      });
    }, 350);
    return () => clearTimeout(t);
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- block operations ---------- */

  const has = (type: BlockType) => layout.blocks.some((b) => b.type === type);
  const update = (b: Block) => setLayout((l) => ({ blocks: l.blocks.map((x) => (x.id === b.id ? b : x)) }));
  // Applied to the block as it is in the layout at that moment (a result landing after an await).
  const updateBlockById = (id: string, fn: (b: Block) => Block) => setLayout((l) => ({ blocks: l.blocks.map((x) => (x.id === id ? fn(x) : x)) }));
  // Keyboard focus after adding / removing a block (the focused control unmounts): the new
  // block's inspector heading, else the neighbouring row, else "Ajouter un bloc".
  const pendingFocus = useRef<{ kind: "detail" } | { kind: "row"; id: string } | { kind: "add" } | null>(null);
  // Leaving the inspector ("Tous les blocs", Escape): back on the block's row, not on <body>.
  const prevSelected = useRef(selected);
  useEffect(() => {
    const prev = prevSelected.current;
    prevSelected.current = selected;
    if (!prev || selected || pendingFocus.current) return;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (lost) pendingFocus.current = { kind: "row", id: prev };
  }, [selected]);
  useEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    pendingFocus.current = null;
    const el =
      p.kind === "detail"
        ? document.getElementById("block-detail-heading")
        : p.kind === "row"
          ? document.querySelector<HTMLElement>(`[data-row-open="${window.CSS.escape(p.id)}"]`)
          : document.getElementById("builder-add-block");
    el?.focus({ preventScroll: false });
  }, [layout, selected, palette]);
  const remove = (id: string) => {
    const i = layout.blocks.findIndex((x) => x.id === id);
    const neighbour = layout.blocks[i + 1] ?? layout.blocks[i - 1];
    pendingFocus.current = neighbour ? { kind: "row", id: neighbour.id } : { kind: "add" };
    setLayout((l) => ({ blocks: l.blocks.filter((x) => x.id !== id) }));
    if (selected === id) setSelected(null);
    showToast({ message: "Bloc supprimé", action: { label: "Annuler", run: () => travel("undo") } });
  };
  const duplicate = (b: Block) => {
    if (isSingleton(b.type)) return;
    // A copy is a new block: tagged when it still holds example content (hidden from buyers).
    const copy = tagDuplicate({ ...structuredClone(b), id: newBlockId() } as Block);
    setLayout((l) => {
      const i = l.blocks.findIndex((x) => x.id === b.id);
      return { blocks: [...l.blocks.slice(0, i + 1), copy, ...l.blocks.slice(i + 1)] };
    });
    setSelected(copy.id);
  };
  const move = (id: string, dir: -1 | 1) =>
    setLayout((l) => {
      const i = l.blocks.findIndex((x) => x.id === id);
      const j = i + dir;
      if (j < 0 || j >= l.blocks.length) return l;
      return { blocks: arrayMove(l.blocks, i, j) };
    });
  /**
   * Index a new block goes to: after the chosen block, else before Payment (checkout) /
   * at the end — except one-click offers, right after the confirmation (above the fold on mobile).
   */
  const insertIndex = (blocks: Block[], type?: BlockType | null) => insertionIndex(blocks, page, insertAfter, type);
  const openPalette = (after: string | null) => {
    setInsertAfter(after);
    setQuery("");
    setActiveIdx(0);
    setHoverType(null);
    setPalette(true);
  };
  const closePalette = () => {
    setPalette(false);
    setQuery("");
    setHoverType(null);
  };
  const add = (type: BlockType) => {
    if (isSingleton(type) && has(type)) return;
    setHoverType(null);
    // A new message is signed with the store name (editable, the role stays « L'équipe »).
    const block = signedWithStore(createBlock(type), storeLabel());
    setLayout((l) => {
      const at = insertIndex(l.blocks, type);
      return { blocks: [...l.blocks.slice(0, at), block, ...l.blocks.slice(at)] };
    });
    setSelected(block.id);
    pendingFocus.current = { kind: "detail" };
    closePalette();
  };
  // Template shown on the canvas while its card is hovered / focused in the Modèles menu (never saved).
  const [templatePreview, setTemplatePreview] = useState<Template | null>(null);
  // Closing the Modèles menu in any way (Escape, its button, a click outside) drops the hovered
  // template, so reopening it never shows a stale preview (state adjusted during render).
  const [previewPopover, setPreviewPopover] = useState(popover);
  if (previewPopover !== popover) {
    setPreviewPopover(popover);
    const kept = previewAfterPopover(popover, templatePreview);
    if (kept !== templatePreview) setTemplatePreview(kept);
  }
  const [templateCategory, setTemplateCategory] = useState<TemplateCategory | "all">("all");
  // Template being confirmed: stays on the canvas behind the confirmation dialog.
  const [confirmingTemplate, setConfirmingTemplate] = useState<Template | null>(null);
  // Setup warnings' store context. The free-shipping bar's automatic threshold is the lowest
  // "free over" of the active rates; the order-bump list shows nothing without an active add-on.
  const setupCtx = useMemo(
    () => ({ hasFreeShippingRate: props.rates.some((r) => r.active && r.freeOverCents != null), hasAddOns: props.addOns.length > 0 }),
    [props.rates, props.addOns],
  );
  async function applyTemplate(t: Template) {
    setPopover(null);
    setConfirmingTemplate(t);
    // Blocks the template hides (Minimal: add-ons, trust badges) are named apart from the kept ones.
    const hiddenBy = blocksHiddenBy(t, layout);
    const kept = blocksKeptAside(t.spec, layout).filter((b) => !hiddenBy.includes(b));
    const keptNames = [...new Set(kept.map((b) => BLOCK_META[b.type].label))].join(", ");
    const hiddenNames = [...new Set(hiddenBy.map((b) => BLOCK_META[b.type].label))].join(", ");
    const built = t.build(layout, { storeName: storeLabel() }).blocks;
    // The matching page (same look) can be applied in the same step: from the checkout its
    // thank-you page (proposed, checked), from the thank-you page its checkout (unchecked).
    const match = page === "checkout" ? matchingThankYou(t) : matchingCheckout(t);
    const matchLabel = page === "checkout" ? "la page de remerciement assortie" : "le checkout assorti";
    const choice = { other: page === "checkout" && !!match };
    const builtOther = match ? match.build(otherLayout, { storeName: storeLabel() }).blocks : [];
    const otherSetup = Object.keys(setupWarnings(builtOther, setupCtx)).length;
    // Sample content and example promises of both pages the dialog may apply.
    // (the other page's count only while its checkbox is checked: TemplateApplyNotes)
    const samplesHere = Object.keys(sampleWarnings(built)).length;
    const samplesOther = Object.keys(sampleWarnings(builtOther)).length;
    // Example content already published (untagged, still shown to buyers) is worded by kind, apart
    // from the example promises.
    const visibleHere = visibleSampleIds(built);
    const visibleOther = visibleSampleIds(builtOther);
    const visibleKinds = (blocks: Block[], ids: string[]) => blocks.filter((b) => ids.includes(b.id)).map((b) => b.type);
    const promisesHere = Object.keys(promiseWarnings(built)).filter((id) => !visibleHere.includes(id)).length;
    const promisesOther = Object.keys(promiseWarnings(builtOther)).filter((id) => !visibleOther.includes(id)).length;
    // A dark header behind a logo drawn for a light one (dark logo on white) may vanish.
    const darkHeaderLogo =
      !!t.style && !!theme.logoUrl && headerModeOf(theme) === "logo" && readableOn(t.style.headerBackground) === "#ffffff" && readableOn(theme.headerBackground) !== "#ffffff";
    const ok = await ask({
      title: `Appliquer le modèle « ${t.name} » ?`,
      body: (
        <>
          <span className="block">
            Les blocs du modèle sont placés sur la page {page === "checkout" ? "checkout" : "de remerciement"} ({t.summary}). Ceux que la page a déjà gardent
            leurs textes, produits et visibilité ; les autres sont ajoutés avec un contenu d&apos;exemple.
            {kept.length > 0 && <> Vos autres blocs ({keptNames}) sont conservés.</>}
            {hiddenBy.length > 0 && (
              <> Pour rester épuré, ce modèle masque {hiddenNames} : leur contenu est gardé, réaffichez-les en un clic dans la liste des blocs.</>
            )}
          </span>
          {t.style ? (
            <span className="mt-2 block">
              Le style (couleurs, polices, boutons, en-tête) est aussi remplacé, sur les deux pages. Votre logo, bannière, nom de boutique, taille du texte, liens légaux et
              réglages sont conservés.
              {page === "checkout" && !match && " La page de remerciement assortie est dans ses Modèles."}
            </span>
          ) : (
            <span className="mt-2 block">Le style n&apos;est pas modifié.</span>
          )}
          {darkHeaderLogo && (
            <span role="note" className="mt-2 flex gap-1.5 rounded-md bg-amber-50 p-2 text-amber-950 ring-1 ring-amber-200">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                Ce modèle a un en-tête sombre : si votre logo est foncé, il sera peu visible. Importez une version claire du logo ou changez la couleur
                d&apos;en-tête dans Style.
              </span>
            </span>
          )}
          <TemplateApplyNotes
            samples={{ here: samplesHere, other: samplesOther }}
            promises={{ here: promisesHere, other: promisesOther }}
            visibleSamples={{ here: visibleKinds(built, visibleHere), other: visibleKinds(builtOther, visibleOther) }}
            match={match ? { label: matchLabel, summary: match.summary, setup: otherSetup } : null}
            defaultOther={choice.other}
            onOtherChange={(v) => (choice.other = v)}
          />
          <span className="mt-2 block">Vous pouvez annuler avec {mod}Z.</span>
        </>
      ),
      confirm: "Appliquer",
    });
    setTemplatePreview(null);
    setConfirmingTemplate(null);
    if (!ok) return;
    const both = !!match && choice.other;
    const styled = t.style ? applyTemplateTheme(latest.current.theme, t) : latest.current.theme;
    // Remembered in the draft for the "Actuel" badge of the Modèles menu (both pages when applied together).
    const [here, there] = page === "checkout" ? (["checkout", "thankYou"] as const) : (["thankYou", "checkout"] as const);
    const appliedTemplates = { ...styled.appliedTemplates, [here]: t.id, ...(both ? { [there]: match.id } : {}) };
    const next = { layout: t.build(latest.current.layout, { storeName: storeLabel() }), theme: { ...styled, appliedTemplates } };
    // Always its own undo step (layout, style and the matching page together), and the next
    // edit, however quick, is a step of its own too.
    lastPush.current = 0;
    sealStep.current = true;
    setLayout(next.layout);
    setTheme(next.theme);
    if (both) setOtherLayout(match.build(latest.current.other, { storeName: storeLabel() }));
    setSelected(null);
    setTab("blocks");
    setPalette(false);
    // "Annuler" undoes the template only while it is still the latest step.
    showToast({ message: `Modèle « ${t.name} » appliqué${both ? " (checkout et remerciement)" : ""}`, action: { label: "Annuler", run: () => travel("undo"), while: next } });
  }

  const selectBlock = useCallback((id: string) => {
    setSelected(id);
    setTab("blocks");
    setPalette(false);
    if (window.matchMedia("(max-width: 767px)").matches) setMobileView("panel");
    panelScroll.current?.scrollTo({ top: 0 });
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  function onDragOver(e: DragOverEvent) {
    if (!e.over || e.active.id === e.over.id) {
      setDropHint(null);
      return;
    }
    const from = layout.blocks.findIndex((b) => b.id === e.active.id);
    const to = layout.blocks.findIndex((b) => b.id === e.over!.id);
    setDropHint({ id: String(e.over.id), edge: from < to ? "bottom" : "top" });
  }
  function onDragEnd(e: DragEndEvent) {
    setDropHint(null);
    if (!e.over || e.active.id === e.over.id) return;
    setLayout((l) => {
      const from = l.blocks.findIndex((b) => b.id === e.active.id);
      const to = l.blocks.findIndex((b) => b.id === e.over!.id);
      return { blocks: arrayMove(l.blocks, from, to) };
    });
  }

  const setT = <K extends keyof Theme>(k: K, v: Theme[K]) => setTheme((t) => ({ ...t, [k]: v }));
  // The banner's proportions, measured once per image (whatever panel is open): its box is sized
  // before it loads on the checkout. Neither an undo step nor an autosave of its own (see
  // onlyBannerRatioChanged), but written by the next save / publish.
  const bannerUrl = theme.bannerUrl;
  const bannerRatio = theme.bannerRatio;
  useEffect(() => {
    if (!bannerUrl) return;
    let live = true;
    const img = new Image();
    const setRatio = (r: number | undefined) =>
      setTheme((t) => (t.bannerUrl !== bannerUrl || t.bannerRatio === r ? t : { ...t, bannerRatio: r }));
    img.onload = () => {
      if (!live || !img.naturalWidth || !img.naturalHeight) return;
      const r = Math.min(20, Math.max(1, Math.round((img.naturalWidth / img.naturalHeight) * 1000) / 1000));
      if (r !== bannerRatio) setRatio(r);
    };
    // An image that doesn't load (404, protected link) has no proportions: the previous image's
    // ratio must not size the band (the checkout falls back to its default height).
    img.onerror = () => {
      if (live && bannerRatio != null) setRatio(undefined);
    };
    img.src = bannerUrl;
    return () => {
      live = false;
    };
  }, [bannerUrl, bannerRatio]);
  // An uploaded image was deleted ("Mes images"): every field of the draft showing it is emptied,
  // in the undo / redo snapshots too (undo must never bring a deleted image back). The cleared
  // values are shared (one clearUrl per object), so the draft matches the cleared last snapshot
  // and the clearing is no undo step of its own.
  const clearDeletedImage = useCallback((url: string) => {
    const done = new Map<object, object>();
    const clear = <T extends object>(v: T): T => {
      if (!done.has(v)) done.set(v, clearUrl(v, url));
      return done.get(v) as T;
    };
    const clearSnap = (s: Snap): Snap => {
      const theme = clear(s.theme);
      const layout = clear(s.layout);
      const other = clear(s.other);
      return theme === s.theme && layout === s.layout && other === s.other ? s : { theme, layout, other };
    };
    past.current = past.current.map(clearSnap);
    future.current = future.current.map(clearSnap);
    prevSnap.current = clearSnap(prevSnap.current);
    setTheme((t) => clear(t));
    setLayout((l) => clear(l));
    setOtherLayout((l) => clear(l));
  }, []);
  const base = `/dashboard/stores/${props.storeId}`;
  const paletteTypes = page === "checkout" ? CHECKOUT_PALETTE : THANK_YOU_PALETTE;
  const templates = page === "checkout" ? CHECKOUT_TEMPLATES : THANK_YOU_TEMPLATES;
  const selectedBlock = layout.blocks.find((b) => b.id === selected) ?? null;
  const names = useMemo(() => Object.fromEntries(layout.blocks.map((b) => [b.id, BLOCK_META[b.type].label])), [layout.blocks]);
  // Merchant-only setup warnings: a badge on the block outline, never inside the buyer's card.
  // (setupCtx: defined above applyTemplate.)
  const warnings = useMemo(() => layoutWarnings(layout.blocks, setupCtx), [layout.blocks, setupCtx]);
  // The canvas's cart (sample lines) has goods to ship: Google Pay on "auto" stays hidden there.
  const previewShippable = props.sampleLines.some((l) => l.requiresShipping);
  // Every block the live page would skip (sample-only content, empty text, no end date, no link,
  // no add-on…): drawn greyed on the canvas with « Invisible pour vos clients ».
  const invisibleToBuyers = useMemo(
    () => hiddenFromBuyers(layout.blocks, { ...setupCtx, expressCheckout: theme.expressCheckout, expressMethods: theme.expressMethods, shippable: previewShippable }),
    [layout.blocks, setupCtx, theme.expressCheckout, theme.expressMethods, previewShippable],
  );
  // Checkout: the payment-logos block shown next to « Paiement » (its own pill, not greyed); the
  // same wallets as the canvas's checkout (its express settings, for the previewed cart).
  const headerLogos = useMemo(
    () => logosInPaymentHeader(layout.blocks, theme.expressCheckout, theme.expressMethods, { shippable: previewShippable }),
    [layout.blocks, theme.expressCheckout, theme.expressMethods, previewShippable],
  );
  // Checkout: where each block really shows (list hints, inspector, insertion choices).
  const zones = useMemo<Record<string, CheckoutZone>>(() => (page === "checkout" ? checkoutZones(layout.blocks) : {}), [layout.blocks, page]);
  // Publishing covers both pages: the other page's incomplete blocks are listed too.
  const otherPage: Page = page === "checkout" ? "thank-you" : "checkout";
  const [publishWarnings, publishPromises] = useMemo(() => {
    const list = (check: (blocks: Block[]) => Record<string, string>, blocks: Block[], where: Page) =>
      Object.entries(check(blocks)).map(([id, text]) => {
        const b = blocks.find((x) => x.id === id)!;
        return { id, page: where, text: `${BLOCK_META[b.type].label} — ${text.charAt(0).toLowerCase()}${text.slice(1)}` };
      });
    const both = (check: (blocks: Block[]) => Record<string, string>) => [...list(check, layout.blocks, page), ...list(check, otherLayout.blocks, otherPage)];
    // Amber list: example promises plus store notes (the untouched add-ons list without add-ons).
    return [both((blocks) => setupWarnings(blocks, setupCtx)), both((blocks) => reviewNotes(blocks, setupCtx))];
  }, [layout.blocks, page, otherLayout.blocks, otherPage, setupCtx]);
  // Untagged blocks (published before) still showing example content to buyers, both pages.
  const shownSamples = useMemo(() => visibleSampleIds(layout.blocks).length + visibleSampleIds(otherLayout.blocks).length, [layout.blocks, otherLayout.blocks]);
  // « Masquer les exemples »: tags them so their example content is hidden live (one undo step).
  const hideExamples = () => {
    lastPush.current = 0;
    sealStep.current = true;
    const next = { layout: { ...latest.current.layout, blocks: hideVisibleSamples(latest.current.layout.blocks) }, theme: latest.current.theme };
    setLayout(next.layout);
    setOtherLayout((l) => ({ ...l, blocks: hideVisibleSamples(l.blocks) }));
    // "Annuler" undoes it only while it is still the latest step (like a template).
    // « Masquer les exemples » disappears with them: focus goes to the toast's « Annuler », not to <body>.
    showToast({ message: "Exemples masqués pour vos clients", action: { label: "Annuler", run: () => travel("undo"), while: next }, focusAction: true });
  };
  // Modèles cards: how many blocks each template would leave to complete on this page (hidden
  // from buyers until set up: countdown date, sample reviews, offer product…).
  // Checkout: plus those of the matching thank-you page, applied with it by default.
  const templateSetup = useMemo<Record<string, { here: number; thankYou: number }>>(
    () =>
      popover === "templates"
        ? Object.fromEntries(
            templates.map((t) => {
              const here = Object.keys(setupWarnings(t.build(layout).blocks, setupCtx)).length;
              const match = page === "checkout" ? matchingThankYou(t) : null;
              return [t.id, { here, thankYou: match ? Object.keys(setupWarnings(match.build(otherLayout).blocks, setupCtx)).length : 0 }];
            }),
          )
        : {},
    [popover, templates, layout, otherLayout, page, setupCtx],
  );
  // The template last applied on this page (saved in the draft; renamed ids mapped).
  const currentTemplateId = canonicalTemplateId(theme.appliedTemplates?.[page === "checkout" ? "checkout" : "thankYou"]);
  const images = useMemo(
    () => (theme.logoUrl && !props.images.some((i) => i.url === theme.logoUrl) ? [...props.images, { url: theme.logoUrl, label: "Logo de la boutique" }] : props.images),
    [props.images, theme.logoUrl],
  );

  /* ---------- inline text editing on the canvas ---------- */

  const inlineEditing = useMemo<InlineEditing>(() => {
    const find = (id: string) => layout.blocks.find((b) => b.id === id);
    const fieldsOf = (b: Block | undefined): string[] => {
      if (!b) return [];
      if (b.type === "text") return ["heading", "body"];
      if (b.type === "announcement") return ["text"];
      if (b.type === "message") return ["title"];
      if (b.type === "express") return ["title", "dividerLabel"];
      if (isFixedSection(b.type) || b.type === "order_addons" || b.type === "shipping_protection") return ["title"];
      return [];
    };
    const MAX: Record<string, number> = { title: 120, heading: 200, body: 2000, text: 300, dividerLabel: 40 };
    // The schema's cap for this block's field (the message title allows more than section titles).
    const maxOf = (b: Block, field: string) => (b.type === "message" && field === "title" ? MESSAGE_LIMITS.title : (MAX[field] ?? 200));
    return {
      fields: (id) => fieldsOf(find(id)),
      value: (id, field) => {
        const v = (find(id)?.props as Record<string, unknown> | undefined)?.[field];
        return typeof v === "string" ? v : "";
      },
      multiline: (field) => field === "body" || field === "text",
      commit: (id, field, value) => {
        lastPush.current = 0; // its own undo step
        setLayout((l) => ({
          blocks: l.blocks.map((b) => (b.id === id ? ({ ...b, props: { ...b.props, [field]: value.slice(0, maxOf(b, field)) } } as Block) : b)),
        }));
        setSelected(id);
      },
    };
  }, [layout.blocks]);

  /* ---------- Apple Pay / Google Pay availability hint (dismissible, remembered) ---------- */

  const expressHintDismissed = useSyncExternalStore(subscribeHint, readHintDismissed, () => true);
  const expressBlock = layout.blocks.find((b) => b.type === "express");
  const showExpressHint =
    page === "checkout" && !expressHintDismissed && !!expressBlock && expressBlock.type === "express" && expressBlock.props.enabled && theme.expressCheckout;
  const dismissExpressHint = () => {
    try {
      localStorage.setItem(EXPRESS_HINT_KEY, "1");
    } catch {
      /* private mode: hidden for this page view only */
    }
    hintDismissedFallback = true;
    window.dispatchEvent(new Event(EXPRESS_HINT_KEY));
  };

  const previewLang = previewLangPick ?? theme.language;
  const translatedPreview = previewLang !== theme.language;
  // Modèles menu: the hovered / focused template, drawn over the current design (not saved).
  const previewingTemplate = confirmingTemplate ?? (popover === "templates" ? templatePreview : null);
  const templateLook = useMemo(
    () => (previewingTemplate ? { theme: applyTemplateTheme(theme, previewingTemplate), layout: previewingTemplate.build(layout, { storeName: theme.storeName.trim() || props.storeName }) } : null),
    [previewingTemplate, theme, layout, props.storeName],
  );
  const shownTheme = templateLook?.theme ?? theme;
  // Fonts of the design on the canvas (a previewed template's own fonts included).
  const fonts = [fontHref(shownTheme.font), shownTheme.headingFont !== "same" ? fontHref(shownTheme.headingFont) : null].filter(Boolean) as string[];
  const shownLayout = templateLook?.layout ?? layout;
  const previewTheme = useMemo(() => (translatedPreview ? { ...shownTheme, language: previewLang } : shownTheme), [shownTheme, previewLang, translatedPreview]);
  const preview =
    page === "checkout" ? (
      <CheckoutView
        theme={previewTheme}
        layout={shownLayout}
        currency={props.currency}
        lines={props.sampleLines}
        rates={props.rates}
        addOns={props.addOns}
        hasDiscounts={props.hasDiscounts}
        // With overlays on, the overlays draw the selection; the preview stays inert.
        mode={{ kind: "preview", selectedBlockId: interact ? selected : null }}
      />
    ) : (
      <ThankYouView
        theme={previewTheme}
        layout={shownLayout}
        preview={{ selectedBlockId: interact ? selected : null, onSelectBlock: selectBlock }}
        data={props.thankYouData}
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
  // Settings that are not blocks (quantity breaks, codes, shipping rates): searching for them
  // points to the dashboard page where they live instead of "no block found".
  const pointers = query.trim() ? PALETTE_POINTERS.filter((x) => norm(`${x.label} ${x.target} ${x.keywords}`).includes(norm(query.trim()))) : [];
  // Flattened library for the combobox keyboard navigation (↑ ↓ Entrée): blocks, then pointers.
  const paletteFlat: string[] = [...groups.flatMap((g) => g.types), ...pointers.map((x) => `link:${x.key}`)];
  const activeKey: string | undefined = paletteFlat[Math.min(activeIdx, paletteFlat.length - 1)];
  const activeType: BlockType | undefined = activeKey && !activeKey.startsWith("link:") ? (activeKey as BlockType) : undefined;
  // One computation for the canvas marker and the wording: the hovered / focused library
  // item's real spot (a one-click offer lands after « Confirmation », not at the end).
  // While searching, the highlighted result (Enter inserts it) counts as the focused item.
  const targetType: BlockType | null = hoverType ?? (query.trim() ? (activeType ?? null) : null);
  const insertAt = insertIndex(layout.blocks, targetType);
  // Reassurance widgets always land in the summary column: "Insérer" has no say for them.
  const autoPlaced = page === "checkout" && targetType != null && isReassuranceWidget(targetType);
  const labelAt = (at: number) => {
    const next = layout.blocks[at];
    const prev = layout.blocks[at - 1];
    if (!insertAfter && next?.type === "payment") return "avant « Paiement »";
    if (!prev) return next ? `avant « ${BLOCK_META[next.type].label} »` : "dans la page";
    return `après « ${BLOCK_META[prev.type].label} »${at >= layout.blocks.length ? " (fin de la page)" : ""}`;
  };
  // Checkout: the hovered block's rendered zone (a reassurance widget shows in the summary
  // column, a content block under the payment), not just its place in the list.
  const hoverZone = page === "checkout" && targetType ? insertedZone(layout.blocks, insertAt, targetType) : null;
  const payIdx = layout.blocks.findIndex((b) => b.type === "payment");
  const insertLabel =
    hoverZone && hoverZone !== "form" && (hoverZone !== "after" || (payIdx >= 0 && insertAt <= payIdx)) ? (zoneWording(hoverZone) ?? labelAt(insertAt)) : labelAt(insertAt);
  // Nothing hovered yet: types whose own spot differs from the default one are named too.
  const offerAt = insertIndex(layout.blocks, "upsell");
  const offerLabel = !targetType && offerAt !== insertAt && page === "thank-you" ? labelAt(offerAt) : null;
  // While the library is open, the canvas shows where the new block will land.
  const paletteHint: DropHint = !palette ? null : page === "checkout" ? renderedInsertionHint(layout.blocks, insertAt, targetType) : insertionHint(layout.blocks, insertAt);
  const optionId = (key: string) => `palette-opt-${key.replace(/:/g, "-")}`;
  // The highlighted block that is already on the page (singleton): the footer offers to go to it.
  const focusType = hoverType ?? activeType ?? null;
  const takenBlock = focusType && isSingleton(focusType) && has(focusType) ? layout.blocks.find((b) => b.type === focusType) ?? null : null;
  const onPaletteKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!paletteFlat.length) return;
    const cur = Math.min(activeIdx, paletteFlat.length - 1);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (cur + 1) % paletteFlat.length;
    else if (e.key === "ArrowUp") next = (cur - 1 + paletteFlat.length) % paletteFlat.length;
    else if (e.key === "Home" && e.ctrlKey) next = 0;
    else if (e.key === "End" && e.ctrlKey) next = paletteFlat.length - 1;
    else if (e.key === "Enter") {
      e.preventDefault();
      const link = activeKey?.startsWith("link:") ? pointers.find((x) => `link:${x.key}` === activeKey) : undefined;
      if (link) void leaveFor(`${base}/${link.path}`);
      else if (activeType && isSingleton(activeType) && has(activeType)) {
        const existing = layout.blocks.find((b) => b.type === activeType);
        if (existing) selectBlock(existing.id);
      } else if (activeType) add(activeType);
      return;
    }
    if (next == null) return;
    e.preventDefault();
    setActiveIdx(next);
    setHoverType(paletteFlat[next].startsWith("link:") ? null : (paletteFlat[next] as BlockType));
    document.getElementById(optionId(paletteFlat[next]))?.scrollIntoView({ block: "nearest" });
  };

  const canPublish = !publishing && (unpublished || state !== "saved");
  // "What will go live": draft (this page's live state + the other page's saved draft) vs published.
  const { published } = props;
  const changes = useMemo<Changes | null>(() => {
    if (popover !== "publish") return null;
    if (!published) return { first: true, rows: [] };
    const checkout = page === "checkout" ? layout : otherLayout;
    const thankYou = page === "checkout" ? otherLayout : layout;
    // Both pages are always listed (publishing covers both), with "aucun changement" when so.
    const rows: [string, string][] = [
      ["Checkout", describeLayoutDiff(diffLayout(checkout, published.checkoutLayout))],
      ["Remerciement", describeLayoutDiff(diffLayout(thankYou, published.thankYouLayout))],
      ["Style", describeThemeDiff(diffTheme(theme, published.theme))],
    ];
    return { first: false, rows: rows.map(([k, text]) => [k, text || "aucun changement"]) };
  }, [popover, published, otherLayout, page, layout, theme]);
  const segBtn = (on: boolean) =>
    `inline-flex items-center justify-center gap-1.5 rounded-lg transition ${RING} ${
      on ? "bg-white font-medium text-zinc-900 shadow-[0_1px_2px_rgba(0,0,0,.08),0_0_0_1px_rgba(0,0,0,.04)]" : "text-zinc-700 hover:text-zinc-950"
    }`;
  // One entry of the publish popover's lists: selects the block (this page) or opens the other page on it.
  const warningLink = (w: { id: string; page: Page; text: string }) => (
        <li key={w.id}>
          {w.page === page ? (
            <button
              type="button"
              onClick={() => {
                setPopover(null);
                selectBlock(w.id);
              }}
              className={`rounded text-left font-medium text-amber-950 underline underline-offset-2 hover:no-underline ${RING}`}
            >
              {w.text}
            </button>
          ) : (
            <Link
              href={`${base}/builder/${w.page}?select=${encodeURIComponent(w.id)}`}
              onClick={(e) => leaveTo(e, `${base}/builder/${w.page}?select=${encodeURIComponent(w.id)}`)}
              className={`rounded font-medium text-amber-950 underline underline-offset-2 hover:no-underline ${RING}`}
            >
              {w.text} <span className="font-normal">({w.page === "checkout" ? "page Checkout" : "page Remerciement"})</span>
            </Link>
          )}
        </li>
  );
  const ghostBtn = `items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-800 shadow-sm transition hover:bg-zinc-50 ${RING}`;
  const menuItem = `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-zinc-800 hover:bg-zinc-100 focus:bg-zinc-100 ${RING}`;

  return (
    <MediaLibraryProvider storeId={props.storeId} onRemoved={clearDeletedImage}>
    <div className="wc-builder flex h-dvh flex-col overflow-hidden bg-[#f6f7f9] text-zinc-900">
      {/* One focus style for every control of the builder (the preview keeps the checkout's own). */}
      <style>{`.wc-builder :is(a,button,summary,select,input,textarea,[role=button],[tabindex]:not([tabindex="-1"])):focus-visible:not(.wc-canvas *){outline:2px solid #6366f1;outline-offset:2px}`}</style>
      {fonts.map((f) => (
        <link key={f} rel="stylesheet" href={f} />
      ))}
      {/* Top bar */}
      <header className="relative z-30 flex min-w-0 items-center gap-1.5 border-b border-zinc-200/80 bg-white/90 px-2 py-2 backdrop-blur-xl sm:gap-2 sm:px-4">
        {/* Inside the banner landmark (axe: all content in landmarks). */}
        <h1 className="sr-only">
          {page === "checkout" ? "Design du checkout" : "Design de la page de remerciement"} — {props.storeName}
        </h1>
        <Link
          href={base}
          onClick={(e) => leaveTo(e, base)}
          aria-label={`Retour à ${props.storeName}`}
          title={props.storeName}
          className={`inline-flex min-w-0 shrink items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-100 hover:text-zinc-950 ${RING}`}
        >
          <ArrowLeft className="h-4 w-4 shrink-0" /> <span className="hidden max-w-[180px] truncate xl:inline">{props.storeName}</span>
        </Link>
        <span className="hidden h-5 w-px shrink-0 bg-zinc-200 sm:block" />
        <nav aria-label="Page à modifier" className="flex shrink-0 rounded-xl bg-zinc-100 p-1 text-sm ring-1 ring-zinc-200/60 ring-inset">
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
              aria-current={page === key ? "page" : undefined}
              aria-label={label}
              title={label}
              className={`${segBtn(page === key)} px-2.5 py-1 sm:px-3`}
            >
              <Icon className="h-3.5 w-3.5" /> <span className="hidden sm:inline">{label}</span>
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
          <div className="hidden rounded-xl bg-zinc-100 p-1 ring-1 ring-zinc-200/60 ring-inset md:flex" role="group" aria-label="Appareil de l'aperçu">
            {(
              [
                ["desktop", Monitor, "Aperçu ordinateur"],
                ["mobile", Smartphone, "Aperçu mobile"],
              ] as const
            ).map(([d, Icon, label]) => (
              <button key={d} type="button" onClick={() => setDevice(d)} title={label} aria-label={label} aria-pressed={device === d} className={`${segBtn(device === d)} p-1.5`}>
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
          <label className="relative hidden items-center xl:flex" title={`Langue de l'aperçu : ${LANGS.find((l) => l.code === previewLang)?.label ?? previewLang}${translatedPreview ? " (traductions des blocs)" : " (langue de la boutique)"}`}>
            <span className="sr-only">Langue de l&apos;aperçu</span>
            <Languages className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-zinc-600" aria-hidden />
            <select
              value={previewLang}
              onChange={(e) => {
                const v = e.target.value as Theme["language"];
                setPreviewLang(v === theme.language ? null : v);
              }}
              className={`h-8 w-[4.25rem] appearance-none rounded-xl pr-2 pl-7 text-xs font-semibold ring-1 ring-inset ${translatedPreview ? "bg-indigo-50 text-indigo-900 ring-indigo-200" : "bg-zinc-100 text-zinc-800 ring-zinc-200/60 hover:bg-zinc-200/70"} ${RING}`}
            >
              {LANGS.map((l) => (
                <option key={l.code} value={l.code} title={`${l.label}${l.code === theme.language ? " (langue de la boutique)" : ""}`}>
                  {l.code.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <div className="hidden rounded-xl bg-zinc-100 p-1 ring-1 ring-zinc-200/60 ring-inset sm:flex" role="group" aria-label="Historique des modifications">
            <button
              type="button"
              onClick={() => travel("undo")}
              disabled={historyDepth.undo === 0}
              title={`Annuler (${mod}Z)`}
              aria-label="Annuler"
              aria-keyshortcuts="Control+Z Meta+Z"
              className={`rounded-lg p-1.5 text-zinc-700 transition hover:bg-white hover:text-zinc-950 disabled:opacity-35 disabled:hover:bg-transparent ${RING}`}
            >
              <Undo2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => travel("redo")}
              disabled={historyDepth.redo === 0}
              title={`Rétablir (${mod}⇧Z)`}
              aria-label="Rétablir"
              aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
              className={`rounded-lg p-1.5 text-zinc-700 transition hover:bg-white hover:text-zinc-950 disabled:opacity-35 disabled:hover:bg-transparent ${RING}`}
            >
              <Redo2 className="h-4 w-4" />
            </button>
          </div>

          <SaveIndicator state={state} error={error} />
          <PublishStatus unpublished={unpublished} publishedAt={publishedAt} storeLive={props.storeLive} className="hidden md:inline-flex" />
          <PublishStatus unpublished={unpublished} publishedAt={publishedAt} storeLive={props.storeLive} compact className="inline-flex md:hidden" />

          <div ref={popoverTriggers} className="flex items-center gap-1.5 sm:gap-2">
            {state === "error" && (
              <button type="button" onClick={() => window.location.reload()} className={`${ghostBtn} hidden sm:inline-flex`}>
                <RotateCw className="h-3.5 w-3.5" /> Recharger
              </button>
            )}
            <button type="button" onClick={() => togglePopover("templates")} aria-expanded={popover === "templates"} aria-haspopup="dialog" className={`${ghostBtn} hidden lg:inline-flex`}>
              <LayoutTemplate className="h-3.5 w-3.5" /> Modèles
            </button>
            <button type="button" onClick={() => togglePopover("versions")} aria-expanded={popover === "versions"} aria-haspopup="dialog" className={`${ghostBtn} hidden lg:inline-flex`}>
              <History className="h-3.5 w-3.5" /> Versions
            </button>
            <a href={`${base}/preview/${page}`} target="_blank" rel="noreferrer" onClick={() => pending && void doSave()} className={`${ghostBtn} hidden min-[1400px]:inline-flex`}>
              <ExternalLink className="h-3.5 w-3.5" /> Aperçu
            </a>
            <button
              ref={moreBtnRef}
              type="button"
              onClick={() => {
                setMenuFocus("first");
                togglePopover("menu");
              }}
              onKeyDown={(e) => {
                // Menu-button pattern: arrows open the menu and focus its first/last item.
                if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                e.preventDefault();
                const which = e.key === "ArrowUp" ? "last" : "first";
                setMenuFocus(which);
                if (popover === "menu") focusMenuItem(popoverRef.current, which);
                else setPopover("menu");
              }}
              aria-expanded={popover === "menu"}
              aria-haspopup="menu"
              aria-label="Plus d'actions"
              title="Plus d'actions"
              className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-700 shadow-sm transition hover:bg-zinc-50 ${RING}`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => togglePopover("publish")}
              disabled={!canPublish}
              aria-expanded={popover === "publish"}
              aria-haspopup="dialog"
              title={canPublish ? "Rendre ce design visible par vos clients" : "Aucune modification à publier"}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white shadow-[0_1px_0_rgba(255,255,255,.15)_inset,0_2px_6px_-2px_rgba(0,0,0,.4)] transition hover:bg-zinc-800 disabled:opacity-40 sm:px-4 ${RING}`}
            >
              {publishing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
              Publier
            </button>
          </div>
        </div>

        {popover === "menu" && (
          <MoreMenu
            menuRef={popoverRef}
            initialFocus={menuFocus}
            onClose={() => setPopover(null)}
            onDismiss={() => {
              setPopover(null);
              moreBtnRef.current?.focus();
            }}
            items={[
              { key: "templates", className: "lg:hidden", icon: LayoutTemplate, label: "Modèles de mise en page", run: () => togglePopover("templates") },
              { key: "versions", className: "lg:hidden", icon: History, label: "Versions publiées", run: () => togglePopover("versions") },
              // Small screens only (touch): no keyboard shortcuts in the wording.
              { key: "undo", className: "sm:hidden", icon: Undo2, label: "Annuler", disabled: historyDepth.undo === 0, run: () => travel("undo"), keepOpen: true },
              { key: "redo", className: "sm:hidden", icon: Redo2, label: "Rétablir", disabled: historyDepth.redo === 0, run: () => travel("redo"), keepOpen: true },
              { key: "preview", className: "min-[1400px]:hidden", icon: ExternalLink, label: "Aperçu plein écran", href: `${base}/preview/${page}`, run: () => pending && void doSave() },
              { key: "ab", icon: FlaskConical, label: "Tester en A/B", run: () => togglePopover("ab") },
              ...(state === "error" ? [{ key: "reload", icon: RotateCw, label: "Recharger la page", run: () => window.location.reload() }] : []),
              ...(unpublished ? [{ key: "discard", icon: Trash2, label: "Abandonner le brouillon", danger: true, run: discardDraft }] : []),
            ]}
            footer={
              <div className="space-y-2">
                <PublishStatus unpublished={unpublished} publishedAt={publishedAt} storeLive={props.storeLive} className="inline-flex md:hidden" />
                <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[.08em] text-zinc-600 uppercase">
                  <HelpCircle className="h-3.5 w-3.5" /> Aide
                </p>
                <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-zinc-700">
                  <li>Cliquez un bloc de l&apos;aperçu pour le modifier ; double-cliquez un texte (ou F2) pour l&apos;éditer sur place.</li>
                  <li>
                    {page === "checkout"
                      ? "Paiement express, Contact, Adresse, Mode de livraison et Paiement sont fixes : glissez-les pour les réordonner."
                      : "Confirmation, Adresse & livraison et Récapitulatif sont fixes : placez vos blocs autour."}
                  </li>
                  {page === "checkout" && (
                    <li>Apple Pay / Google Pay n&apos;apparaissent en ligne que si l&apos;appareil de l&apos;acheteur a un wallet configuré ; sinon la zone se masque.</li>
                  )}
                </ul>
                <p className="hidden items-center gap-1.5 text-[11px] text-zinc-600 md:flex">
                  <Keyboard className="h-3.5 w-3.5" /> {mod}Z annuler · {mod}⇧Z rétablir · Échap fermer
                </p>
              </div>
            }
            itemClass={menuItem}
          />
        )}

        {popover === "publish" && (
          <Panel title="Publier le design" onClose={() => setPopover(null)} panelRef={popoverRef}>
            <form
              className="space-y-3 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                void publish();
              }}
            >
              <p className="text-[13px] leading-relaxed text-zinc-700">
                Le checkout <strong>et</strong> la page de remerciement deviennent visibles par vos clients. Une version est gardée dans l&apos;historique.
              </p>
              {publishPromises.length > 0 && (
                <div role="note" aria-labelledby="publish-promises" className="rounded-lg bg-amber-50 p-3 ring-1 ring-amber-200">
                  <p id="publish-promises" className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
                    <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    À vérifier (ne bloque pas la publication) :
                  </p>
                  <ul className="mt-1.5 space-y-1 text-xs">{publishPromises.map(warningLink)}</ul>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-amber-900">
                    Remboursement, livraison offerte, délais, support : vérifiez que ces engagements correspondent à ce que vous offrez vraiment, sinon modifiez-les.
                  </p>
                  {shownSamples > 0 && (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-amber-200 pt-2">
                      <span className="text-[11px] leading-relaxed text-amber-900">
                        {shownSamples} bloc{shownSamples > 1 ? "s" : ""} montre{shownSamples > 1 ? "nt" : ""} encore du contenu d&apos;exemple à vos clients.
                      </span>
                      <button
                        type="button"
                        onClick={hideExamples}
                        className={`shrink-0 rounded-md bg-white px-2 py-1 text-xs font-medium text-amber-950 ring-1 ring-amber-300 hover:bg-amber-100 ${RING}`}
                      >
                        Masquer les exemples
                      </button>
                    </div>
                  )}
                </div>
              )}
              {publishWarnings.length > 0 && (
                <div role="note" aria-labelledby="publish-warnings" className="rounded-lg bg-amber-50 p-3 ring-1 ring-amber-200">
                  <p id="publish-warnings" className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
                    <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {publishWarnings.length} bloc{publishWarnings.length > 1 ? "s" : ""} à compléter :
                  </p>
                  <ul className="mt-1.5 space-y-1 text-xs">{publishWarnings.map(warningLink)}</ul>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-amber-900">Ces blocs restent invisibles pour vos clients tant qu&apos;ils ne sont pas complétés.</p>
                </div>
              )}
              <ChangeSummary changes={changes} />
              <F label="Nom de la version (facultatif)">
                <input
                  autoFocus
                  value={versionName}
                  maxLength={80}
                  onChange={(e) => setVersionName(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-zinc-900"
                />
              </F>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setPopover(null)} className={`${ghostBtn} inline-flex`}>
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={publishing}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${RING} ${
                    publishWarnings.length ? "bg-amber-700 text-white hover:bg-amber-800" : "bg-zinc-900 text-white hover:bg-zinc-800"
                  }`}
                >
                  {publishing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}{" "}
                  {publishWarnings.length ? "Publier quand même" : "Publier maintenant"}
                </button>
              </div>
            </form>
          </Panel>
        )}

        {popover === "versions" && (
          <Panel
            title="Versions publiées"
            onClose={() => setPopover(null)}
            panelRef={popoverRef}
            footer={
              // The state itself is the top bar's pill: the footer only offers what to do with a draft.
              unpublished ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-zinc-600">Modifications non publiées en cours</span>
                  <button type="button" onClick={discardDraft} className={`shrink-0 rounded text-xs font-medium text-red-700 hover:underline ${RING}`}>
                    Abandonner le brouillon
                  </button>
                </div>
              ) : undefined
            }
          >
            {props.versions.length === 0 ? (
              <div className="p-3">
                <EmptyState icon={History} title="Aucune version dans l'historique">
                  {publishedAt
                    ? "Le design en ligne a été publié avant l'historique des versions. Publiez pour enregistrer une première version restaurable."
                    : "Cliquez sur « Publier » pour mettre ce design en ligne : chaque publication est gardée ici et peut être restaurée."}
                </EmptyState>
              </div>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {props.versions.map((v) => (
                  <VersionRow key={v.id} v={v} canRestore={!v.current || unpublished} onRestore={() => restoreVersion(v)} />
                ))}
              </ul>
            )}
          </Panel>
        )}

        {popover === "templates" && (
          <Panel
            title={page === "checkout" ? "Modèles de checkout" : "Modèles de remerciement"}
            onClose={() => setPopover(null)}
            panelRef={popoverRef}
            width="w-[28rem]"
            // Docked left, over the block list: the canvas (and its summary column) stays visible.
            side="left"
            footer={
              <p className="text-[11px] leading-relaxed text-zinc-600">
                Survolez un modèle pour le voir sur la page. Les modèles avec pastilles de couleur changent aussi le style (logo, nom et textes conservés).
                Annulable avec {mod}Z.
              </p>
            }
          >
            <div role="group" aria-label="Catégories de modèles" className="flex flex-wrap gap-1.5 px-3 pt-3">
              {[{ key: "all" as const, label: "Tous" }, ...TEMPLATE_CATEGORIES].map((c) => (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={templateCategory === c.key}
                  onClick={() => setTemplateCategory(c.key)}
                  className={`min-h-8 rounded-full px-3 text-xs font-medium transition ${RING} ${
                    templateCategory === c.key ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <ul
              className="space-y-2 p-3"
              onMouseLeave={() => setTemplatePreview(null)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTemplatePreview(null);
              }}
            >
              {templates
                .filter((t) => templateCategory === "all" || t.category === templateCategory)
                .map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => applyTemplate(t)}
                      onMouseEnter={() => setTemplatePreview(t)}
                      onFocus={() => setTemplatePreview(t)}
                      data-template={t.id}
                      // Starts with the visible words (WCAG 2.5.3: "Appliquer" + the name).
                      aria-label={`Appliquer le modèle ${t.name}${currentTemplateId === t.id ? " (actuel)" : ""}`}
                      aria-describedby={`tpl-${t.id}-desc`}
                      className={`group w-full rounded-xl border bg-white p-3 text-left transition hover:border-zinc-300 hover:shadow-md ${RING} ${
                        templatePreview?.id === t.id ? "border-indigo-300 shadow-md" : "border-zinc-200"
                      }`}
                    >
                      <span className="flex gap-3">
                        <TemplateThumb spec={t.spec} page={page} look={t.style} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span id={`tpl-${t.id}-name`} className="text-sm font-semibold">
                                {t.name}
                              </span>
                              {currentTemplateId === t.id && (
                                <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 ring-1 ring-emerald-200">
                                  Actuel
                                </span>
                              )}
                            </span>
                            <span className="inline-flex items-center gap-0.5 text-xs font-medium text-indigo-700">
                              Appliquer <ChevronRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
                            </span>
                          </span>
                          {t.style && (
                            <span className="mt-1 flex items-center gap-1" aria-hidden>
                              {[t.style.headerBackground, t.style.accentColor, t.style.accentColor2, t.style.summaryBackground].filter(Boolean).map((c, i) => (
                                <span key={i} className="h-3 w-3 rounded-full ring-1 ring-black/15" style={{ background: c }} />
                              ))}
                              <span className="ml-1 text-[11px] text-zinc-600">
                                {styleFonts(t)}
                              </span>
                            </span>
                          )}
                          <span id={`tpl-${t.id}-desc`}>
                            {(t.idealFor || (templateSetup[t.id]?.here ?? 0) + (templateSetup[t.id]?.thankYou ?? 0) > 0) && (
                              <span className="mt-1 flex flex-wrap items-center gap-1.5">
                                {t.idealFor && (
                                  <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-800">
                                    Idéal pour : {t.idealFor}
                                    <span className="sr-only">.</span>
                                  </span>
                                )}
                                {(templateSetup[t.id]?.here ?? 0) + (templateSetup[t.id]?.thankYou ?? 0) > 0 && (
                                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-800">
                                    <TriangleAlert className="h-3 w-3" aria-hidden />
                                    {templateSetup[t.id].here > 0 && (
                                      <>
                                        {templateSetup[t.id].here} bloc{templateSetup[t.id].here > 1 ? "s" : ""} à compléter
                                      </>
                                    )}
                                    {templateSetup[t.id].thankYou > 0 &&
                                      `${templateSetup[t.id].here > 0 ? " " : ""}+${templateSetup[t.id].thankYou}${templateSetup[t.id].here > 0 ? "" : ` bloc${templateSetup[t.id].thankYou > 1 ? "s" : ""} à compléter`} sur la page de remerciement`}
                                    <span className="sr-only">.</span>
                                  </span>
                                )}
                              </span>
                            )}
                            <span className="mt-0.5 block text-xs leading-relaxed text-zinc-700">{t.description}</span>
                            {t.style && <span className="sr-only">Change aussi le style : {styleFonts(t)}.</span>}
                            {/* The block list on one line (cards never change height on hover): all of it in the tooltip, always read by screen readers. */}
                            <span title={t.summary} className="mt-1 line-clamp-1 block text-[11px] leading-relaxed text-zinc-600">
                              {t.summary}
                            </span>
                          </span>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
            <div className="border-t border-zinc-100 p-3">
              <button type="button" onClick={() => togglePopover("ab")} className={`${menuItem} text-indigo-800`}>
                <FlaskConical className="h-4 w-4" /> Comparer deux designs : tester en A/B
              </button>
            </div>
          </Panel>
        )}

        {popover === "ab" && (
          <Panel title="Tester en A/B" onClose={() => setPopover(null)} panelRef={popoverRef}>
            <div className="space-y-3 p-4 text-[13px] leading-relaxed text-zinc-700">
              <p>Montrez un autre design à une partie de vos visiteurs et gardez celui qui convertit le mieux.</p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>
                  Publiez le design à tester : il devient une <strong>version</strong>.
                </li>
                <li>Republiez ou restaurez votre design de référence.</li>
                <li>Dans Statistiques, lancez le test : choisissez la version B et la part du trafic.</li>
              </ol>
              <Link
                href={`${base}/analytics`}
                onClick={(e) => leaveTo(e, `${base}/analytics`)}
                className={`inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 ${RING}`}
              >
                <FlaskConical className="h-3.5 w-3.5" /> Ouvrir les tests A/B
              </Link>
            </div>
          </Panel>
        )}
      </header>

      {/* Mobile: panel and preview each take the full width */}
      <nav aria-label="Affichage" className="border-b border-zinc-200/80 bg-white px-3 py-2 md:hidden">
        <div className="grid grid-cols-2 rounded-xl bg-zinc-100 p-1 text-sm ring-1 ring-zinc-200/60 ring-inset" role="group" aria-label="Affichage">
          <button type="button" aria-pressed={mobileView === "panel"} onClick={() => setMobileView("panel")} className={`${segBtn(mobileView === "panel")} py-1.5`}>
            <PanelLeft className="h-4 w-4" /> Panneau
          </button>
          <button type="button" aria-pressed={mobileView === "canvas"} onClick={() => setMobileView("canvas")} className={`${segBtn(mobileView === "canvas")} py-1.5`}>
            <Eye className="h-4 w-4" /> Aperçu
          </button>
        </div>
      </nav>

      <main aria-label="Éditeur" className="flex min-h-0 min-w-0 flex-1">
        {/* Settings column */}
        <section
          aria-label="Réglages"
          className={`${mobileView === "panel" ? "flex" : "hidden"} relative z-20 w-full min-w-0 shrink-0 flex-col border-r border-zinc-200/80 bg-white md:flex md:w-[372px]`}
        >
          <div className="p-3">
            <div className="grid grid-cols-2 rounded-xl bg-zinc-100 p-1 text-sm ring-1 ring-zinc-200/60 ring-inset" role="tablist" aria-label="Réglages">
              {(
                [
                  ["blocks", "Blocs", Layers],
                  ["style", "Style", Palette],
                ] as const
              ).map(([key, label, Icon]) => (
                <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={`${segBtn(tab === key)} py-1.5`}>
                  <Icon className="h-4 w-4" /> {label}
                </button>
              ))}
            </div>
          </div>

          <div ref={panelScroll} className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
            {tab === "style" ? (
              <>
                <PanelHeading>Style de la boutique</PanelHeading>
                <StylePanel theme={theme} setT={setT} page={page} storeName={props.storeName} images={images} />
              </>
            ) : selectedBlock ? (
              <BlockDetail
                key={selectedBlock.id}
                block={selectedBlock}
                blocks={layout.blocks}
                page={page}
                images={images}
                index={layout.blocks.indexOf(selectedBlock)}
                count={layout.blocks.length}
                onBack={() => setSelected(null)}
                onChange={update}
                onDuplicate={() => duplicate(selectedBlock)}
                onRemove={() => remove(selectedBlock.id)}
                onMove={(d) => move(selectedBlock.id, d)}
                onAddAfter={() => openPalette(selectedBlock.id)}
                expressOn={theme.expressCheckout}
                setExpressOn={(v) => setT("expressCheckout", v)}
                expressMethods={theme.expressMethods ?? DEFAULT_EXPRESS_METHODS}
                setExpressMethods={(v) => setT("expressMethods", v)}
                addOns={props.addOns}
                money={(c) => formatMoney(c, props.currency, "fr-FR")}
                offersHref={`${base}/offers`}
                onLeave={leaveTo}
                context={{
                  blocks: layout.blocks,
                  storeId: props.storeId,
                  currency: props.currency,
                  lang: theme.language,
                  productTitles: Object.fromEntries(props.sampleLines.map((l) => [l.productId, l.title])),
                  protectionTest: props.protectionTest ?? null,
                  updateBlock: updateBlockById,
                }}
              />
            ) : (
              <>
                <PanelHeading
                  action={
                    <div ref={paletteTrigger}>
                      <button
                        type="button"
                        id="builder-add-block"
                        onClick={() => (palette ? closePalette() : openPalette(null))}
                        aria-expanded={palette}
                        aria-haspopup="dialog"
                        className={`inline-flex items-center gap-1 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-zinc-800 ${RING}`}
                      >
                        {palette ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />} {palette ? "Fermer" : "Ajouter un bloc"}
                      </button>
                    </div>
                  }
                >
                  Blocs de la page
                </PanelHeading>

                {layout.blocks.length === 0 ? (
                  <EmptyState
                    icon={Layers}
                    title="Aucun bloc supplémentaire"
                    action={
                      <div className="flex flex-wrap justify-center gap-2">
                        <button type="button" onClick={() => openPalette(null)} className={`${ghostBtn} inline-flex text-xs`}>
                          <Plus className="h-3.5 w-3.5" /> Ajouter un bloc
                        </button>
                        <button type="button" onClick={() => togglePopover("templates")} className={`${ghostBtn} inline-flex text-xs`}>
                          <LayoutTemplate className="h-3.5 w-3.5" /> Partir d&apos;un modèle
                        </button>
                      </div>
                    }
                  >
                    La confirmation, le récapitulatif et l&apos;adresse sont toujours affichés. Ajoutez un code promo, un upsell ou vos réseaux.
                  </EmptyState>
                ) : (
                  <DndContext
                    id="builder-blocks"
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragOver={onDragOver}
                    onDragEnd={onDragEnd}
                    onDragCancel={() => setDropHint(null)}
                  >
                    <SortableContext items={layout.blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
                      <ul className="space-y-1.5" aria-label="Blocs de la page">
                        {layout.blocks.map((b, i) => (
                          <SortableRow
                            key={b.id}
                            block={b}
                            page={page}
                            first={i === 0}
                            last={i === layout.blocks.length - 1}
                            onOpen={() => setSelected(b.id)}
                            onHide={() => update({ ...b, hidden: !b.hidden })}
                            onDuplicate={() => duplicate(b)}
                            onRemove={() => remove(b.id)}
                            onMove={(d) => move(b.id, d)}
                            {...expressRowState(b, theme)}
                            warning={warnings[b.id]}
                            zone={zones[b.id]}
                            untranslated={translatedPreview ? untranslatedCount(b, previewLang) : 0}
                            previewLang={previewLang}
                          />
                        ))}
                      </ul>
                    </SortableContext>
                  </DndContext>
                )}
              </>
            )}
          </div>
          {palette && (
            <div
              ref={paletteRef}
              role="dialog"
              aria-label="Bibliothèque de blocs"
              className="absolute top-14 right-3 bottom-3 left-3 z-40 flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_24px_60px_-16px_rgba(15,23,42,.4)] md:right-auto md:w-[420px] xl:right-3 xl:w-auto"
            >
              <div className="border-b border-zinc-100 p-3">
                <div className="mb-2.5 flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">Ajouter un bloc</p>
                  <button type="button" onClick={closePalette} aria-label="Fermer la bibliothèque" className={`rounded-md p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 ${RING}`}>
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setActiveIdx(0);
                      setHoverType(null);
                    }}
                    onKeyDown={onPaletteKey}
                    placeholder="Rechercher un bloc…"
                    aria-label="Rechercher un bloc"
                    role="combobox"
                    aria-expanded={paletteFlat.length > 0}
                    aria-controls={paletteFlat.length ? "palette-listbox" : undefined}
                    aria-autocomplete="list"
                    aria-activedescendant={activeKey ? optionId(activeKey) : undefined}
                    aria-describedby="palette-kbd-hint"
                    className="w-full rounded-lg border border-zinc-200 bg-white py-1.5 pr-2 pl-8 text-sm outline-none focus:border-zinc-400"
                  />
                </div>
                <label className="mt-2.5 flex items-center gap-2 text-xs text-zinc-700">
                  <ListPlus className="h-3.5 w-3.5 shrink-0 text-indigo-600" aria-hidden />
                  <span className="shrink-0 font-medium">Insérer</span>
                  <select
                    value={autoPlaced ? "__auto" : (insertAfter ?? "")}
                    disabled={autoPlaced}
                    onChange={(e) => setInsertAfter(e.target.value || null)}
                    className="min-w-0 flex-1 truncate rounded-md border border-zinc-200 bg-white px-1.5 py-1 text-xs outline-none focus:border-zinc-400 disabled:bg-zinc-50 disabled:text-zinc-700"
                  >
                    {autoPlaced && <option value="__auto">Emplacement automatique</option>}
                    <option value="">
                      {page === "checkout" && has("payment") ? "Avant « Paiement » (par défaut)" : has("ty_confirmation") ? "Par défaut (fin ; offre 1 clic après la confirmation)" : "À la fin de la page"}
                    </option>
                    {page === "checkout"
                      ? // Only spots of the form column, grouped by where they show: blocks of the
                        // summary column have no "after" there (a new block never lands beside them).
                        (
                          [
                            ["form", "Formulaire, au-dessus du paiement"],
                            ["after", "Sous le paiement"],
                          ] as const
                        ).map(([zone, label]) => {
                          const opts = layout.blocks.filter((b) => (b.type === "payment" ? "after" : zones[b.id]) === zone);
                          return opts.length ? (
                            <optgroup key={zone} label={label}>
                              {opts.map((b) => (
                                <option key={b.id} value={b.id}>
                                  Après « {BLOCK_META[b.type].label} »
                                </option>
                              ))}
                            </optgroup>
                          ) : null;
                        })
                      : layout.blocks.map((b) => (
                          <option key={b.id} value={b.id}>
                            Après « {BLOCK_META[b.type].label} »
                          </option>
                        ))}
                    {page === "checkout" && insertAfter && zones[insertAfter] && zones[insertAfter] !== "form" && zones[insertAfter] !== "after" && (
                      <option value={insertAfter}>Après « {names[insertAfter]} » (récapitulatif)</option>
                    )}
                  </select>
                </label>
              </div>
              <p id="palette-kbd-hint" className="sr-only">
                Flèches haut et bas pour parcourir les blocs, Entrée pour insérer le bloc en surbrillance.
              </p>
              <div className="flex min-h-0 flex-1 flex-col">
              {paletteFlat.length > 0 && (
              // The listbox itself scrolls and is focusable by script (axe: scrollable region
              // reachable by keyboard); mousedown keeps focus in the search field.
              <div
                id="palette-listbox"
                role="listbox"
                aria-label="Blocs disponibles"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 outline-none"
              >
                {groups.map((g) => (
                  <div key={g.key} role="group" aria-labelledby={`palette-group-${g.key}`} className="mb-1.5 last:mb-0">
                    <p id={`palette-group-${g.key}`} className="px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-[.1em] text-zinc-600 uppercase">
                      {g.label}
                    </p>
                    <ul role="presentation">
                      {g.types.map((t) => {
                        const m = BLOCK_META[t];
                        const taken = isSingleton(t) && has(t);
                        const active = t === activeType;
                        return (
                          <li key={t} role="presentation">
                            <button
                              type="button"
                              id={optionId(t)}
                              role="option"
                              aria-selected={active}
                              tabIndex={-1}
                              onClick={() => add(t)}
                              onMouseEnter={() => {
                                setHoverType(t);
                                setActiveIdx(paletteFlat.indexOf(t));
                              }}
                              onMouseLeave={() => setHoverType((h) => (h === t ? null : h))}
                              aria-disabled={taken}
                              className={`group flex w-full items-center gap-3 rounded-xl p-2 text-left transition ${RING} ${active ? "bg-indigo-50 ring-1 ring-indigo-200" : ""} ${taken ? "cursor-not-allowed opacity-50" : "hover:bg-zinc-50"}`}
                            >
                              <BlockThumb type={t} />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1.5 text-[13px] leading-tight font-medium">
                                  <m.icon className="h-3.5 w-3.5 shrink-0 text-indigo-600" aria-hidden />
                                  {m.label}
                                </span>
                                <span className="mt-0.5 block truncate text-[11px] leading-snug text-zinc-600">{taken ? "Déjà sur la page (un seul possible)" : m.description}</span>
                              </span>
                              {!taken && <Plus className="h-4 w-4 shrink-0 text-zinc-400 transition group-hover:text-zinc-900" aria-hidden />}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
                {pointers.length > 0 && (
                  <div role="group" aria-labelledby="palette-group-elsewhere" className="mb-1.5 last:mb-0">
                    <p id="palette-group-elsewhere" className="px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-[.1em] text-zinc-600 uppercase">
                      Ailleurs dans le tableau de bord
                    </p>
                    <ul role="presentation">
                      {pointers.map((x) => {
                        const key = `link:${x.key}`;
                        const active = key === activeKey;
                        return (
                          <li key={key} role="presentation">
                            <a
                              href={`${base}/${x.path}`}
                              id={optionId(key)}
                              role="option"
                              aria-selected={active}
                              tabIndex={-1}
                              onClick={(e) => leaveTo(e, `${base}/${x.path}`)}
                              onMouseEnter={() => {
                                setHoverType(null);
                                setActiveIdx(paletteFlat.indexOf(key));
                              }}
                              className={`group flex w-full items-center gap-3 rounded-xl p-2 text-left transition ${RING} ${active ? "bg-indigo-50 ring-1 ring-indigo-200" : "hover:bg-zinc-50"}`}
                            >
                              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600" aria-hidden>
                                <x.icon className="h-4 w-4" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-1.5 text-[13px] leading-tight font-medium">
                                  {x.label}
                                  <ArrowRight className="h-3 w-3 shrink-0 text-zinc-400" aria-hidden />
                                  <span className="text-indigo-700">{x.target}</span>
                                </span>
                                <span className="mt-0.5 block text-[11px] leading-snug text-zinc-600">{x.description}</span>
                              </span>
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
              )}
              {paletteFlat.length === 0 && (
                <p role="status" className="p-5 text-center text-xs text-zinc-600">
                  Aucun bloc ne correspond à « {query} ».{" "}
                  <button type="button" onClick={() => setQuery("")} className={`rounded font-medium text-indigo-700 hover:underline ${RING}`}>
                    Effacer
                  </button>
                </p>
              )}
              </div>
              {takenBlock ? (
                <div className="flex items-center justify-between gap-2 border-t border-zinc-100 bg-zinc-50/70 px-3 py-2 text-[11px] text-zinc-600">
                  <p>
                    <strong className="font-semibold text-zinc-800">Déjà sur la page</strong> : « {BLOCK_META[takenBlock.type].label} » n&apos;existe qu&apos;une fois.
                  </p>
                  <button
                    type="button"
                    onClick={() => selectBlock(takenBlock.id)}
                    className={`inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg bg-white px-2.5 text-xs font-medium text-zinc-900 shadow-sm ring-1 ring-zinc-200 hover:bg-zinc-50 ${RING}`}
                  >
                    Aller au bloc <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              ) : (
                <p className="border-t border-zinc-100 bg-zinc-50/70 px-3 py-2 text-[11px] text-zinc-600">
                  {targetType ? `« ${BLOCK_META[targetType].label} » sera inséré` : "Le bloc sera inséré"}{" "}
                  <strong className="font-semibold text-zinc-800">{insertLabel}</strong>
                  {offerLabel && (
                    <>
                      {" "}
                      ; une « {BLOCK_META.upsell.label} », <strong className="font-semibold text-zinc-800">{offerLabel}</strong>
                    </>
                  )}
                  .
                </p>
              )}
            </div>
          )}
        </section>

        {/* Live preview */}
        <section
          aria-label="Aperçu en direct"
          className={`${mobileView === "canvas" ? "block" : "hidden"} relative min-w-0 flex-1 overflow-auto bg-[radial-gradient(circle,#d4d4d8_1px,transparent_1px)] [background-size:18px_18px] p-3 md:block md:p-8`}
        >
          <div className="mb-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-[11px] font-medium text-zinc-600">
            <span className="inline-flex items-center gap-1.5">
              {interact ? <Hand className="h-3.5 w-3.5" /> : <MousePointerClick className="h-3.5 w-3.5" />}
              {interact ? "Mode interaction : l'aperçu réagit comme pour un client" : "Cliquez un bloc pour le modifier"}
            </span>
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-white/90 px-2.5 py-1 text-zinc-700 shadow-sm ring-1 ring-zinc-200">
              <input type="checkbox" checked={interact} onChange={(e) => setInteract(e.target.checked)} className="h-3.5 w-3.5 accent-zinc-900" />
              Interagir avec l&apos;aperçu
            </label>
            <span className="text-zinc-600" title={props.realSample ? "Produits du dernier panier de votre boutique" : "Aucun panier réel pour l'instant : produits d'exemple"}>
              · {props.realSample ? "Produits de votre dernier panier" : "Produits d'exemple"}
            </span>
          </div>
          {showExpressHint && (
            <div role="note" className="mx-auto mb-3 flex max-w-[640px] items-start gap-2 rounded-xl bg-white/95 px-3 py-2 text-[12px] leading-snug text-zinc-700 shadow-sm ring-1 ring-zinc-200">
              <Info className="mt-px h-4 w-4 shrink-0 text-indigo-600" aria-hidden />
              <p className="min-w-0 flex-1">
                <strong className="font-semibold text-zinc-900">Apple Pay / Google Pay :</strong> en ligne, ces boutons n&apos;apparaissent que si l&apos;appareil de
                l&apos;acheteur a un wallet configuré (et le domaine validé côté Whop). Sinon la zone se masque et il paie par carte ou PayPal.
              </p>
              <button type="button" onClick={dismissExpressHint} aria-label="Masquer cette information" className={`shrink-0 rounded-md p-0.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 ${RING}`}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <div
            // overflow-clip (not hidden): keeps the rounded frame without breaking the
            // summary column's position: sticky inside the scrolling canvas.
            className={`mx-auto overflow-clip bg-white shadow-[0_24px_60px_-20px_rgba(15,23,42,.25),0_0_0_1px_rgba(15,23,42,.06)] transition-[max-width] duration-300 ${
              device === "mobile" ? "max-w-[400px] rounded-[2.2rem] border-[10px] border-zinc-900" : "max-w-[1200px] rounded-2xl"
            }`}
          >
            {device === "desktop" && (
              <div className="hidden items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-2.5 md:flex">
                <span className="flex gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
                </span>
                <span className="mx-auto flex items-center gap-1.5 rounded-md bg-white px-3 py-0.5 text-[11px] text-zinc-600 ring-1 ring-zinc-200">
                  <Lock className="h-3 w-3" /> {page === "checkout" ? "checkout sécurisé" : "commande confirmée"}
                </span>
              </div>
            )}
            <div className="relative">
              <div ref={previewRoot} className="wc-canvas" inert={!interact ? true : undefined}>
                {preview}
              </div>
              {previewingTemplate && (
                // Visual cue only: the focused card already names the template (no live region on every hover).
                <p aria-hidden className="pointer-events-none absolute top-3 left-3 z-10 rounded-full bg-zinc-900/90 px-3 py-1 text-xs font-medium text-white shadow-lg">
                  Aperçu : {previewingTemplate.name}
                </p>
              )}
              {!interact && !previewingTemplate && (
                <CanvasOverlays
                  rootRef={previewRoot}
                  page={page}
                  blocks={layout.blocks}
                  selected={selected}
                  names={names}
                  warnings={warnings}
                  invisible={invisibleToBuyers}
                  logosInHeader={headerLogos}
                  onSelect={selectBlock}
                  dropHint={dropHint ?? paletteHint}
                  // Inline edits write the store-language text: off while previewing a translation.
                  inline={translatedPreview ? undefined : inlineEditing}
                />
              )}
            </div>
          </div>
        </section>
      </main>

      {toast && (
        <div
          role="status"
          onMouseEnter={() => setToastHeld(true)}
          onMouseLeave={() => setToastHeld(false)}
          onFocus={() => setToastHeld(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setToastHeld(false);
          }}
          className="fixed bottom-4 left-1/2 z-50 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl bg-zinc-900 py-2.5 pr-2.5 pl-4 text-sm text-white shadow-2xl">
          <span className="min-w-0 flex-1">{toast.message}</span>
          {toast.action && (!toast.action.while || (toast.action.while.layout === layout && toast.action.while.theme === theme)) && (
            <button
              ref={toastAction}
              type="button"
              onClick={() => {
                toast.action!.run();
                setToast(null);
              }}
              className="min-w-0 max-w-[13rem] rounded-md bg-white/10 px-2.5 py-1 text-left text-xs leading-snug font-semibold hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-white sm:max-w-none"
            >
              {toast.action.label}
            </button>
          )}
          <button type="button" onClick={() => setToast(null)} aria-label="Fermer" className="shrink-0 rounded-md p-1 text-white/70 hover:text-white focus-visible:outline-2 focus-visible:outline-white">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {confirmDialog}
    </div>
    </MediaLibraryProvider>
  );
}

/* ------------------------------------------------------------------ */
/* Top bar pieces                                                      */
/* ------------------------------------------------------------------ */

type Changes = { first: boolean; rows: [string, string][] };

/** Short "what changes" list in the publish popover (draft vs published design). */
function ChangeSummary({ changes }: { changes: Changes | null }) {
  if (!changes) return null;
  return (
    <div className="rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200/70">
      <p className="mb-1.5 text-[11px] font-semibold tracking-[.08em] text-zinc-600 uppercase">Changements</p>
      {changes.first ? (
        <p className="text-xs text-zinc-700">Première publication : tout le design sera mis en ligne.</p>
      ) : (
        <dl className="space-y-1 text-xs">
          {changes.rows.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="w-[6.5rem] shrink-0 font-medium text-zinc-800">{k} :</dt>
              <dd className={`min-w-0 ${v === "aucun changement" ? "text-zinc-500" : "font-medium text-zinc-900"}`}>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** Autosave state only: "Enregistré" / "Enregistrement…" / error. */
function SaveIndicator({ state, error }: { state: SaveState; error: string | null }) {
  const map = {
    saved: [CloudCheck, "Enregistré", "text-zinc-600", ""],
    // Autosave starts within a second: same short word as the save itself (fits the slot at any width).
    dirty: [LoaderCircle, "Enregistrement…", "text-zinc-600", ""],
    saving: [LoaderCircle, "Enregistrement…", "text-zinc-600", "animate-spin"],
    error: [CloudAlert, "Non enregistré", "text-red-700", ""],
  } as const;
  const [Icon, label, color, spin] = map[state];
  return (
    // Fixed-width slot: the toolbar never shifts when the wording changes.
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex shrink-0 items-center gap-1.5 px-1 text-xs whitespace-nowrap min-[1400px]:w-[132px] ${color}`}
      title={error ? `Erreur d'enregistrement : ${error}` : label}
    >
      <Icon className={`h-4 w-4 shrink-0 ${spin}`} aria-hidden />
      {/* Icon only below 1400 px (tooltip + screen readers): room for the publication status. */}
      <span className="sr-only min-[1400px]:not-sr-only">{label}</span>
    </span>
  );
}

/** Publication state, one source of truth: draft vs published date. Same wording everywhere. */
function PublishStatus({
  unpublished,
  publishedAt,
  className = "inline-flex",
  compact = false,
  storeLive = true,
}: {
  unpublished: boolean;
  publishedAt: string | null;
  className?: string;
  /** Store offline: buyers don't see this checkout at all, whatever is published. */
  storeLive?: boolean;
  /** Short word + dot (small screens: never color alone); the full wording is in the tooltip and for screen readers. */
  compact?: boolean;
}) {
  const ago = useRelativeTime(publishedAt);
  const [dot, label, title, short] = unpublished
    ? ["bg-amber-400", "Brouillon non publié", publishedAt ? `Vos clients voient la version publiée ${ago}.` : "Vos clients voient le design d'origine.", "Brouillon"]
    : publishedAt
      ? ["bg-emerald-500", `Publié · ${ago}`, "Vos clients voient exactement ce design.", "Publié"]
      : ["bg-zinc-400", "Jamais publié", "Vos clients voient le design d'origine.", "Non publié"];
  const offline = "Boutique hors ligne : vos clients ne voient pas encore ce checkout (activez-la dans Paramètres).";
  const [dotShown, labelShown, titleShown] =
    storeLive || unpublished || !publishedAt ? [dot, label, storeLive ? title : offline] : ["bg-zinc-400", "Publié · hors ligne", `${label}. ${offline}`];
  if (compact)
    return (
      <span
        title={`${labelShown} — ${titleShown}`}
        className={`shrink-0 items-center gap-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-zinc-800 ring-1 ring-zinc-200/70 ${className}`}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${dotShown}`} aria-hidden />
        <span aria-hidden>{short}</span>
        <span className="sr-only">{`${labelShown}. ${titleShown}`}</span>
      </span>
    );
  return (
    <span
      // The label may be truncated in a narrow toolbar (≈1024 px): the tooltip carries it in full.
      title={`${labelShown} — ${titleShown}`}
      // Hugs its wording (no blank space); capped so a long date never pushes the toolbar.
      className={`max-w-[15rem] min-w-0 items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium whitespace-nowrap text-zinc-700 ring-1 ring-zinc-200/70 ${className}`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotShown}`} aria-hidden />
      <span className="min-w-0 truncate">{labelShown}</span>
      <span className="sr-only">{`. ${titleShown}`}</span>
    </span>
  );
}

function VersionRow({ v, canRestore, onRestore }: { v: Version; canRestore: boolean; onRestore: () => void }) {
  const ago = useRelativeTime(v.createdAt);
  return (
    <li className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium break-words">{v.label}</span>
          {v.current && <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 ring-1 ring-emerald-200">Actuelle</span>}
        </span>
        <span className="block text-xs text-zinc-600">
          {new Date(v.createdAt).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })} · {ago}
        </span>
      </span>
      {canRestore && (
        <button type="button" onClick={onRestore} className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 ${RING}`}>
          <RotateCcw className="h-3.5 w-3.5" /> Restaurer
        </button>
      )}
    </li>
  );
}

type MenuEntry = {
  key: string;
  icon: LucideIcon;
  label: string;
  run: () => void;
  className?: string;
  href?: string;
  disabled?: boolean;
  checked?: boolean;
  danger?: boolean;
  keepOpen?: boolean;
};

/** Menu items a keyboard user can reach: rendered at this breakpoint and enabled. */
function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return Array.from(menu?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? []).filter(
    (el) => el.getAttribute("aria-disabled") !== "true" && el.getClientRects().length > 0,
  );
}

function focusMenuItem(menu: HTMLElement | null, which: "first" | "last") {
  const all = menuItems(menu);
  (which === "last" ? all[all.length - 1] : all[0])?.focus();
}

/**
 * "⋯" menu (WAI-ARIA menu button): opens on the first visible, enabled item (or the last
 * one after ArrowUp), arrows/Home/End move between reachable items, Escape closes and
 * returns focus to the button, Tab closes and moves on.
 */
function MoreMenu({
  items,
  onClose,
  onDismiss,
  menuRef,
  initialFocus,
  footer,
  itemClass,
}: {
  items: MenuEntry[];
  onClose: () => void;
  onDismiss: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
  initialFocus: "first" | "last";
  footer: ReactNode;
  itemClass: string;
}) {
  useEffect(() => {
    focusMenuItem(menuRef.current, initialFocus);
    // Only when the menu opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuRef]);
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
      return;
    }
    if (e.key === "Tab") {
      onClose();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const all = menuItems(menuRef.current);
    if (!all.length) return;
    if (e.key === "Home") return all[0].focus();
    if (e.key === "End") return all[all.length - 1].focus();
    const i = all.indexOf(document.activeElement as HTMLElement);
    const next = i < 0 ? (e.key === "ArrowDown" ? 0 : all.length - 1) : (i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length;
    all[next]?.focus();
  }
  return (
    <div
      ref={menuRef}
      className="absolute top-full right-2 z-40 mt-2 w-72 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_20px_50px_-12px_rgba(15,23,42,.35)] sm:right-3"
    >
      <div role="menu" aria-label="Plus d'actions" className="p-1.5" onKeyDown={onKeyDown}>
        {items.map((it) => {
          const Icon = it.icon;
          const cls = `${itemClass} ${it.className ?? ""} ${it.danger ? "text-red-700 hover:bg-red-50 focus:bg-red-50" : ""} ${it.disabled ? "pointer-events-none opacity-40" : ""}`;
          const content = (
            <>
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{it.label}</span>
              {it.checked !== undefined && (
                <span className={`relative inline-flex h-4 w-7 shrink-0 rounded-full transition ${it.checked ? "bg-zinc-900" : "bg-zinc-300"}`} aria-hidden>
                  <span className={`absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-white transition ${it.checked ? "translate-x-3" : ""}`} />
                </span>
              )}
            </>
          );
          if (it.href)
            return (
              <a
                key={it.key}
                role="menuitem"
                tabIndex={-1}
                href={it.href}
                target="_blank"
                rel="noreferrer"
                className={cls}
                onClick={() => {
                  it.run();
                  onClose();
                }}
              >
                {content}
                <ExternalLink className="h-3.5 w-3.5 text-zinc-500" />
              </a>
            );
          return (
            <button
              key={it.key}
              type="button"
              role={it.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              tabIndex={-1}
              aria-checked={it.checked}
              aria-disabled={it.disabled}
              className={cls}
              onClick={() => {
                if (it.disabled) return;
                if (!it.keepOpen) onClose();
                it.run();
              }}
            >
              {content}
            </button>
          );
        })}
      </div>
      <div className="border-t border-zinc-100 bg-zinc-50/70 px-3.5 py-2.5">{footer}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Block editor view (left panel)                                      */
/* ------------------------------------------------------------------ */

function BlockDetail({
  block,
  blocks,
  page,
  images,
  index,
  count,
  onBack,
  onChange,
  onDuplicate,
  onRemove,
  onMove,
  onAddAfter,
  expressOn,
  setExpressOn,
  expressMethods,
  setExpressMethods,
  addOns,
  money,
  offersHref,
  onLeave,
  context,
}: {
  block: Block;
  /** All blocks of the page: the checkout zone depends on the others (arrangeCheckout). */
  blocks: Block[];
  page: Page;
  images: ImageSource[];
  index: number;
  count: number;
  onBack: () => void;
  onChange: (b: Block) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onMove: (d: -1 | 1) => void;
  onAddAfter: () => void;
  /** Legacy theme switch for Apple Pay / Google Pay, kept in sync with the express block. */
  expressOn: boolean;
  setExpressOn: (v: boolean) => void;
  /** Which express buttons show (theme.expressMethods). */
  expressMethods: ExpressMethods;
  setExpressMethods: (v: ExpressMethods) => void;
  addOns: AddOnView[];
  money: (cents: number) => string;
  offersHref: string;
  onLeave: (e: React.MouseEvent, href: string) => void;
  context: EditorContext;
}) {
  const meta = BLOCK_META[block.type];
  const fixed = isFixedSection(block.type);
  const single = isSingleton(block.type);
  const iconBtn = `inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-zinc-700 ring-1 ring-zinc-200 transition hover:bg-zinc-50 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40 ${RING}`;
  return (
    <div>
      <button type="button" onClick={onBack} className={`mb-2 inline-flex items-center gap-1 rounded-md px-1 py-1 text-xs font-medium text-zinc-700 hover:text-zinc-950 ${RING}`}>
        <ChevronLeft className="h-4 w-4" /> Tous les blocs
      </button>
      <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50/60 p-3">
        <IconTile icon={meta.icon} size={32} color={fixed ? "#71717a" : "#6366f1"} />
        <div className="min-w-0 flex-1">
          <h2 id="block-detail-heading" tabIndex={-1} className="text-sm leading-snug font-semibold break-words outline-none">
            {meta.label}
          </h2>
          <p className="text-[11px] leading-snug text-zinc-600">
            {meta.description}
            {fixed && " · section fixe"}
            {block.hidden && " · masqué"}
          </p>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        <button type="button" className={iconBtn} onClick={() => onMove(-1)} disabled={index <= 0} aria-label="Monter le bloc" title="Monter">
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={iconBtn} onClick={() => onMove(1)} disabled={index >= count - 1} aria-label="Descendre le bloc" title="Descendre">
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
        {!fixed && (
          <>
            <button type="button" className={iconBtn} onClick={() => onChange({ ...block, hidden: !block.hidden })} aria-pressed={block.hidden}>
              {block.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} {block.hidden ? "Afficher" : "Masquer"}
            </button>
            <Tip text={single ? "Ce bloc ne peut apparaître qu'une fois" : null} side="bottom">
              <button
                type="button"
                className={`${iconBtn} ${single ? "cursor-not-allowed opacity-40 hover:bg-transparent" : ""}`}
                onClick={single ? undefined : onDuplicate}
                aria-disabled={single || undefined}
                title={single ? undefined : "Dupliquer"}
              >
                <Copy className="h-3.5 w-3.5" /> Dupliquer
              </button>
            </Tip>
            <button type="button" className={`${iconBtn} hover:!bg-red-50 hover:!text-red-700`} onClick={onRemove}>
              <Trash2 className="h-3.5 w-3.5" /> Supprimer
            </button>
          </>
        )}
        <button type="button" className={`${iconBtn} ml-auto`} onClick={onAddAfter} title="Ouvrir la bibliothèque et insérer un bloc juste après celui-ci">
          <Plus className="h-3.5 w-3.5" /> Ajouter après
        </button>
      </div>

      <PanelHeading>Contenu</PanelHeading>
      <div className="space-y-4 px-1">
        {block.type === "express" && (
          <div className="space-y-3">
            <Check
              label="Afficher les paiements express"
              checked={block.props.enabled && expressOn}
              onChange={(v) => {
                onChange({ ...block, props: { ...block.props, enabled: v } });
                if (v && !expressOn) setExpressOn(true);
              }}
            />
            {block.props.enabled && expressOn && <ExpressMethodsEditor value={expressMethods} onChange={setExpressMethods} />}
            <F label="Titre" hint="Vide = « Paiement express » traduit">
              <Text value={block.props.title} placeholder={emptyTextDefault("express", "title", context.lang ?? "fr") ?? undefined} onChange={(title) => onChange({ ...block, props: { ...block.props, title } })} />
            </F>
            <F label="Texte du séparateur" hint="Vide = « OU » traduit">
              <Text value={block.props.dividerLabel} placeholder={emptyTextDefault("express", "dividerLabel", context.lang ?? "fr") ?? undefined} onChange={(dividerLabel) => onChange({ ...block, props: { ...block.props, dividerLabel: dividerLabel.slice(0, 40) } })} />
            </F>
            <p className="flex gap-1.5 rounded-lg bg-zinc-50 p-2.5 text-[11px] leading-relaxed text-zinc-600 ring-1 ring-zinc-200/70">
              <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              En ligne, les boutons n&apos;apparaissent que sur un appareil avec Apple Pay ou Google Pay configuré ; sinon la zone se masque d&apos;elle-même.
            </p>
          </div>
        )}
        <BlockContentEditor block={block} onChange={onChange} images={images} context={context} />
        {block.type === "order_addons" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-zinc-700">Options actives ({addOns.length})</p>
              <Link
                href={offersHref}
                onClick={(e) => onLeave(e, offersHref)}
                className={`inline-flex items-center gap-1 rounded text-xs font-medium text-indigo-700 hover:underline ${RING}`}
              >
                Gérer les options <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            {addOns.length === 0 ? (
              <p className="rounded-lg border border-dashed border-zinc-300 p-3 text-center text-[11px] leading-relaxed text-zinc-600">
                Aucune option active : le bloc reste invisible pour vos clients. Créez-en une dans « Gérer les options ».
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg ring-1 ring-zinc-200">
                {addOns.map((a) => (
                  <li key={a.id} className="flex items-center gap-2.5 bg-white px-2.5 py-2 text-xs">
                    {a.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.imageUrl} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover ring-1 ring-zinc-200" />
                    ) : (
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-500">
                        <PackagePlus className="h-4 w-4" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium text-zinc-800">{a.title}</span>
                    <span className="shrink-0 font-semibold text-zinc-900 tabular-nums">+{money(a.priceCents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {page === "checkout" && block.type === "recommendations" && (
          <p className="text-[11px] leading-relaxed text-zinc-600">
            Emplacement fixe : sous le récapitulatif sur ordinateur, juste avant le paiement sur mobile.
          </p>
        )}
        {page === "checkout" && !isFixedSection(block.type) && block.type !== "order_addons" && block.type !== "recommendations" && block.type !== "shipping_protection" && (
          <PlacementField block={block} blocks={blocks} onChange={onChange} />
        )}
      </div>

      <TranslationsEditor block={block} baseLang={context.lang ?? "fr"} onChange={onChange} />

      <details className="group mt-3 rounded-xl border border-zinc-200">
        <summary className={`flex cursor-pointer list-none items-center gap-1.5 rounded-xl px-3 py-2.5 text-xs font-semibold tracking-[.08em] text-zinc-600 uppercase ${RING}`}>
          <Paintbrush className="h-3.5 w-3.5" /> Style du bloc
          <ChevronDown className="ml-auto h-3.5 w-3.5 transition group-open:rotate-180" />
        </summary>
        <div className="border-t border-zinc-200 p-3">
          <StyleEditor style={block.style} onChange={(style) => onChange({ ...block, style })} />
        </div>
      </details>
    </div>
  );
}

/**
 * "Emplacement" of a checkout block, as the canvas really arranges it: reassurance widgets
 * always go to the summary column (explanation, no choice); other blocks choose between the
 * form column (labelled with where they then show) and the summary.
 */
function PlacementField({ block, blocks, onChange }: { block: Block; blocks: Block[]; onChange: (b: Block) => void }) {
  if (isReassuranceWidget(block.type)) {
    return (
      <p className="text-[11px] leading-relaxed text-zinc-600">
        <span className="font-semibold text-zinc-800">Emplacement automatique</span> : dans le récapitulatif, sous le panier sur ordinateur, juste après le paiement sur mobile. Les blocs de
        réassurance y sont regroupés pour ne jamais éloigner le client du paiement.
      </p>
    );
  }
  const formZone = zoneWithPlacement(blocks, block.id, "form");
  const reason = belowPaymentReason(blocks, block.id);
  return (
    <Field label="Emplacement">
      <Segmented
        value={block.placement}
        options={[
          ["form", formZone === "after" ? "Sous le paiement" : "Colonne formulaire"],
          ["summary", "Récapitulatif"],
        ]}
        onChange={(placement) => onChange({ ...block, placement })}
      />
      {reason && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-600">
          {reason === "compact_limit"
            ? `Affiché sous le paiement : ${COMPACT_BEFORE_PAY_MAX} bandeaux courts au plus restent au-dessus, pour garder le bouton de paiement visible.`
            : "Affiché sous le paiement, même placé plus haut dans la liste : les blocs de contenu ne repoussent jamais le paiement."}
        </p>
      )}
    </Field>
  );
}

/** Two themes that differ by the measured banner ratio alone (measured by BuilderApp, never typed). */
function onlyBannerRatioChanged(a: Theme, b: Theme): boolean {
  if (a === b || a.bannerRatio === b.bannerRatio) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof Theme)[]);
  for (const k of keys) if (k !== "bannerRatio" && a[k] !== b[k]) return false;
  return true;
}

function StylePanel({
  theme,
  setT,
  page,
  storeName,
  images,
}: {
  theme: Theme;
  setT: <K extends keyof Theme>(k: K, v: Theme[K]) => void;
  page: Page;
  storeName: string;
  images: ImageSource[];
}) {
  const fontOptions = FONTS.map((f) => [f, f] as [typeof f, string]);
  const hex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);
  // The chosen mode (not the rendered fallback): a banner without an image yet still shows its fields.
  const headerMode = theme.headerMode ?? headerModeOf(theme);
  return (
    <div>
      <PanelSection title="Marque & en-tête" icon={Store} defaultOpen>
        <F label="Nom de la boutique">
          <Text value={theme.storeName} placeholder={storeName} onChange={(v) => setT("storeName", v)} />
        </F>
        <Field label="Contenu de l'en-tête">
          <Segmented
            value={headerMode}
            options={[["name", "Nom de la boutique"], ["logo", "Logo"], ["banner", "Bannière"]]}
            onChange={(v) => setT("headerMode", v)}
          />
        </Field>
        {headerMode === "logo" && (
          <>
            <Field label="Logo" hint="PNG à fond transparent conseillé. Astuce : décochez le nom pour un en-tête logo seul.">
              <ImageField value={theme.logoUrl} images={images} onChange={(v) => setT("logoUrl", v)} />
            </Field>
            <Check label="Afficher aussi le nom à côté du logo" checked={theme.showStoreName} onChange={(v) => setT("showStoreName", v)} />
            <F label={`Hauteur du logo : ${theme.logoHeight} px`}>
              <input type="range" min={16} max={120} value={theme.logoHeight} onChange={(e) => setT("logoHeight", Number(e.target.value))} className="w-full accent-zinc-900" />
            </F>
          </>
        )}
        {headerMode !== "banner" && (
          <Field label="Alignement">
            <Segmented value={theme.headerAlign} options={[["left", "Gauche"], ["center", "Centre"], ["right", "Droite"]]} onChange={(v) => setT("headerAlign", v)} />
          </Field>
        )}
        {headerMode === "banner" && (
          <>
            <Field label="Image de la bannière" hint="Pleine largeur en haut du checkout et de la page de remerciement. Conseillé : 1600 × 300 px environ.">
              <ImageField value={theme.bannerUrl} images={images} onChange={(v) => setT("bannerUrl", v)} />
            </Field>
            <Field label="Hauteur" hint={theme.bannerAuto ? "Sur ordinateur, hauteur limitée à 240 px (et au tiers de l'écran) : une image plus haute est rognée ou centrée selon le cadrage. Sur mobile, l'image occupe toute la largeur, hauteur limitée à un format bannière." : undefined}>
              <Segmented value={theme.bannerAuto ? "auto" : "fixed"} options={[["fixed", "Fixe"], ["auto", "Proportions de l'image"]]} onChange={(v) => setT("bannerAuto", v === "auto")} />
            </Field>
            {!theme.bannerAuto && (
              <F label={`Hauteur de la bannière : ${theme.bannerHeight} px`}>
                <input type="range" min={60} max={240} step={4} value={theme.bannerHeight} onChange={(e) => setT("bannerHeight", Number(e.target.value))} className="w-full accent-zinc-900" />
              </F>
            )}
            <Field label="Cadrage" hint={theme.bannerFit === "cover" ? "L'image remplit la bande (les bords peuvent être rognés)." : "L'image entière est visible, sur la couleur de fond."}>
              <Segmented value={theme.bannerFit} options={[["cover", "Remplir"], ["contain", "Image entière"]]} onChange={(v) => setT("bannerFit", v)} />
            </Field>
            <F label="Fond derrière la bannière" hint="Vide : fond de l'en-tête.">
              <ColorInput value={theme.bannerBackground} onChange={(v) => (v === "" || hex(v)) && setT("bannerBackground", v)} />
            </F>
            <Check label="La bannière renvoie vers la boutique" checked={theme.bannerLink} onChange={(v) => setT("bannerLink", v)} />
          </>
        )}
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
          <Pick value={theme.language} options={LANGS.map((l) => [l.code, l.label]) as [Theme["language"], string][]} onChange={(v) => setT("language", v)} />
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
                <UrlText value={l.url} placeholder="https://…" onChange={(url) => setT("policyLinks", theme.policyLinks.map((x, j) => (j === i ? { ...x, url } : x)))} />
                <button type="button" aria-label="Retirer ce lien" className={`rounded px-1 text-zinc-500 hover:text-red-600 ${RING}`} onClick={() => setT("policyLinks", theme.policyLinks.filter((_, j) => j !== i))}>
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
            {theme.policyLinks.length < 8 && (
              <button type="button" className={`inline-flex items-center gap-1 rounded text-xs font-medium text-indigo-700 hover:underline ${RING}`} onClick={() => setT("policyLinks", [...theme.policyLinks, { label: "", url: "" }])}>
                <Plus className="h-3.5 w-3.5" /> Ajouter un lien
              </button>
            )}
          </div>
        </F>
      </PanelSection>

      <PanelSection title="Conformité UE" icon={Scale}>
        <Check label="Case « J'accepte les CGV » avant de payer" checked={theme.requireTerms} onChange={(v) => setT("requireTerms", v)} />
        <F label="Lien des CGV" hint="Sinon, le lien légal nommé « CGV » ou « Conditions » est utilisé.">
          <UrlText value={theme.termsUrl} placeholder="https://…/pages/cgv" onChange={(v) => setT("termsUrl", v)} />
        </F>
        <F label="Mention sous le total" hint="Ex. « TVA incluse ». Laisser vide pour masquer.">
          <Text value={theme.vatNote} onChange={(v) => setT("vatNote", v)} />
        </F>
        <Check label="Rappel du droit de rétractation (remerciement)" checked={theme.withdrawalNotice} onChange={(v) => setT("withdrawalNotice", v)} />
        <p className="text-[11px] leading-relaxed text-zinc-600">
          Le bouton affiche par défaut « Commander et payer » (mention d&apos;obligation de paiement exigée par le Code de la consommation).
        </p>
      </PanelSection>
    </div>
  );
}


function PanelSection({ title, icon: Icon, children, defaultOpen = false }: { title: string; icon: LucideIcon; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group border-b border-zinc-100 last:border-0">
      <summary className={`flex cursor-pointer list-none items-center gap-2.5 rounded-lg px-1 py-3 text-sm font-medium text-zinc-800 ${RING}`}>
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200/70 ring-inset">
          <Icon className="h-3.5 w-3.5" />
        </span>
        {title}
        <ChevronDown className="ml-auto h-4 w-4 text-zinc-500 transition group-open:rotate-180" />
      </summary>
      <div className="space-y-3.5 px-1 pb-4">{children}</div>
    </details>
  );
}

/** Paiements express: which buttons show at the top of the checkout (theme.expressMethods). */
function ExpressMethodsEditor({ value, onChange }: { value: ExpressMethods; onChange: (v: ExpressMethods) => void }) {
  const set = <K extends keyof ExpressMethods>(k: K, v: ExpressMethods[K]) => onChange({ ...value, [k]: v });
  // Really off (no button whatever the cart), or only Google Pay on "auto" left (hidden as soon as
  // something ships): two distinct notes, never both (see expressMethodsAllOff).
  const allOff = expressMethodsAllOff(value);
  const cartDependent = expressMethodsCartDependent(value);
  return (
    <div role="group" aria-label="Paiements express (en haut du checkout)" className="space-y-2.5 rounded-lg p-2.5 ring-1 ring-zinc-200" data-testid="express-methods-editor">
      <p className="text-xs font-semibold text-zinc-800">Paiements express (en haut du checkout)</p>
      <Check label="Apple Pay" checked={value.applePay} onChange={(v) => set("applePay", v)} />
      <F
        label="Google Pay"
        hint="Google Pay / Apple Pay restent proposés dans le formulaire de paiement si Whop les active."
      >
        <Pick
          value={value.googlePay}
          options={[
            ["off", "Désactivé"],
            ["auto", "Auto (recommandé : seulement si rien à expédier)"],
            ["always", "Toujours"],
          ]}
          onChange={(v) => set("googlePay", v)}
        />
      </F>
      {value.googlePay === "always" && (
        <p role="note" className="flex gap-1.5 rounded-lg bg-amber-50 p-2.5 text-[11px] leading-relaxed text-amber-900 ring-1 ring-amber-200">
          <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          Google Pay express ne transmet pas encore l&apos;adresse de livraison : les commandes sans adresse seront mises en attente pour que vous les complétiez.
        </p>
      )}
      <Check label="Whop Pay" checked={value.whopPay} onChange={(v) => set("whopPay", v)} />
      <Check label="PayPal" checked={value.paypal} onChange={(v) => set("paypal", v)} />
      {value.paypal && <p className="text-[11px] text-zinc-600">PayPal n&apos;apparaît que si Whop l&apos;active pour votre boutique.</p>}
      {cartDependent && (
        <p className="text-[11px] text-zinc-600" data-testid="express-gpay-auto-only">
          Google Pay auto : masqué quand il y a des produits à expédier
        </p>
      )}
      {allOff && <p className="text-[11px] text-zinc-600">Aucun bouton choisi : la zone de paiement express est masquée.</p>}
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-xs font-medium text-zinc-700">
      {label}
      <span className="relative inline-flex shrink-0">
        <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
        <span className="h-5 w-9 rounded-full bg-zinc-300 transition peer-checked:bg-zinc-900 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-indigo-500 peer-focus-visible:outline-solid" />
        <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition peer-checked:translate-x-4" />
      </span>
    </label>
  );
}

function SortableRow(props: {
  block: Block;
  page: Page;
  first: boolean;
  last: boolean;
  onOpen: () => void;
  onHide: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onMove: (d: -1 | 1) => void;
  /** Section switched off (express payment disabled). */
  off?: boolean;
  /** Short state shown under the label, not greyed (e.g. « selon le panier »: see expressRowState). */
  badge?: string;
  /** Setup left to do ("Choisir un produit"): amber mark on the row. */
  warning?: string;
  /** Checkout: where the block really shows (arrangeCheckout). */
  zone?: CheckoutZone;
  /** Custom texts without a translation in the preview language (preview ≠ store language). */
  untranslated?: number;
  previewLang?: string;
}) {
  const { block } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id });
  const fixed = isFixedSection(block.type);
  const single = isSingleton(block.type);
  const meta = BLOCK_META[block.type];
  // The zone the canvas really uses (reassurance widgets → summary column, content → under the payment).
  const where = props.page === "checkout" ? zoneLabel(props.zone) : null;
  const muted = block.hidden || props.off;
  const iconBtn = `rounded-md p-1 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-30 disabled:hover:bg-transparent ${RING}`;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`wc-row group/row rounded-xl border border-zinc-200 bg-white transition-shadow hover:border-zinc-300 ${isDragging ? "z-10 shadow-xl" : ""}`}
    >
      <div className="flex items-center gap-1 px-1.5 py-1.5">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className={`cursor-grab touch-none rounded-md p-1 text-zinc-400 hover:text-zinc-700 active:cursor-grabbing ${RING}`}
          aria-label={`Déplacer « ${meta.label} »`}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={props.onOpen}
          data-row-open={block.id}
          title={meta.label}
          aria-label={`Modifier « ${meta.label} »${props.warning ? ` — à compléter : ${props.warning}` : ""}${props.untranslated ? ` — non traduit en ${props.previewLang?.toUpperCase()}` : ""}`}
          className={`flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md text-left text-sm ${RING} ${muted ? "text-zinc-500" : ""}`}
        >
          <IconTile icon={meta.icon} size={26} color={fixed ? "#71717a" : "#6366f1"} />
          <span className="min-w-0 flex-1">
            <span className={`block truncate leading-tight font-medium ${block.hidden ? "line-through" : ""}`}>{meta.label}</span>
            {(where || muted || props.badge) && (
              <span className="block text-[11px] leading-tight text-zinc-600">
                {[block.hidden ? "Masqué" : props.off ? "Désactivé" : null, props.badge, where].filter(Boolean).join(" · ")}
              </span>
            )}
            {props.warning && <span className="block truncate text-[11px] leading-tight font-medium text-amber-800">{props.warning}</span>}
          </span>
          {!!props.untranslated && (
            <span
              title={`Non traduit en ${props.previewLang?.toUpperCase()} : ${props.untranslated} texte${props.untranslated > 1 ? "s" : ""} personnalisé${props.untranslated > 1 ? "s" : ""} restera${props.untranslated > 1 ? "nt" : ""} dans la langue de la boutique (Traductions du bloc)`}
              className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-amber-800"
              aria-hidden
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              non traduit
            </span>
          )}
          {props.warning && (
            <span title={`À compléter : ${props.warning}`} className="shrink-0 text-amber-600" aria-hidden>
              <TriangleAlert className="h-4 w-4" />
            </span>
          )}
          {fixed && <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-zinc-700 uppercase">fixe</span>}
        </button>
        {/* Actions: on hover / keyboard focus with a mouse, always on touch screens (globals.css). */}
        <span className="wc-row-actions flex shrink-0 items-center">
          <button type="button" className={iconBtn} onClick={() => props.onMove(-1)} disabled={props.first} aria-label={`Monter « ${meta.label} »`} title="Monter">
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={iconBtn} onClick={() => props.onMove(1)} disabled={props.last} aria-label={`Descendre « ${meta.label} »`} title="Descendre">
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          {!fixed && (
            <>
              <button type="button" className={iconBtn} onClick={props.onHide} aria-label={block.hidden ? `Afficher « ${meta.label} »` : `Masquer « ${meta.label} »`} title={block.hidden ? "Afficher" : "Masquer"}>
                {block.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
              <Tip text={single ? "Ce bloc ne peut apparaître qu'une fois" : null} side={props.last ? "top" : "bottom"} align="end">
                <button
                  type="button"
                  className={`${iconBtn} ${single ? "cursor-not-allowed opacity-30 hover:bg-transparent hover:text-zinc-500" : ""}`}
                  onClick={single ? undefined : props.onDuplicate}
                  aria-disabled={single || undefined}
                  aria-label={`Dupliquer « ${meta.label} »`}
                  title={single ? undefined : "Dupliquer"}
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </Tip>
              <button type="button" className={`${iconBtn} hover:!text-red-600`} onClick={props.onRemove} aria-label={`Supprimer « ${meta.label} »`} title="Supprimer">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </span>
      </div>
    </li>
  );
}

/** Example content still shown to buyers, by block kind (template dialog). */
const VISIBLE_SAMPLE_KIND: Partial<Record<BlockType, string>> = {
  reviews: "avis",
  stats: "chiffres",
  testimonial: "témoignage",
  coupon: "code promo",
  announcement: "annonce",
  text: "texte",
};

/**
 * Template dialog: sample / promise notes and the "apply the matching page too" checkbox. The
 * other page's samples and promises count only while its checkbox is checked.
 */
function TemplateApplyNotes(props: {
  samples: { here: number; other: number };
  promises: { here: number; other: number };
  /** Kinds of example content already published and still shown to buyers (untagged blocks). */
  visibleSamples: { here: BlockType[]; other: BlockType[] };
  match: { label: string; summary: string; setup: number } | null;
  defaultOther: boolean;
  onOtherChange: (v: boolean) => void;
}) {
  const [other, setOther] = useState(props.defaultOther);
  const withOther = other && !!props.match;
  const samples = props.samples.here + (withOther ? props.samples.other : 0) > 0;
  const promises = props.promises.here + (withOther ? props.promises.other : 0) > 0;
  const visibleKinds = [...new Set([...props.visibleSamples.here, ...(withOther ? props.visibleSamples.other : [])])]
    .map((t) => VISIBLE_SAMPLE_KIND[t])
    .filter((k): k is string => !!k);
  const { match } = props;
  return (
    <>
      {samples && (
        <span className="mt-2 block">
          Les avis, témoignages, chiffres, codes promo, annonces ou textes d&apos;exemple ne sont jamais montrés à vos clients : remplacez-les par les vôtres pour
          les afficher.
        </span>
      )}
      {visibleKinds.length > 0 && (
        <span className="mt-2 block">
          Déjà publiés, ces contenus d&apos;exemple restent visibles par vos clients : {visibleKinds.join(", ")}. Remplacez-les par les vôtres ou utilisez
          « Masquer les exemples ».
        </span>
      )}
      {promises && (
        <span className="mt-2 block">
          Les promesses d&apos;exemple (garantie, remboursement, livraison offerte, délais, support) sont signalées : vérifiez qu&apos;elles correspondent à votre
          politique.
        </span>
      )}
      {match && (
        <label className="mt-3 flex cursor-pointer items-start gap-2 text-zinc-800">
          <input
            type="checkbox"
            checked={other}
            onChange={(e) => {
              setOther(e.target.checked);
              props.onOtherChange(e.target.checked);
            }}
            aria-describedby="tpl-match-summary"
            className="mt-0.5 h-4 w-4 shrink-0 accent-zinc-900"
          />
          <span>
            <span className="block font-medium">Appliquer aussi {match.label}</span>
            <span id="tpl-match-summary" className="mt-0.5 block text-xs text-zinc-600">
              {match.summary}
              {match.setup > 0 && ` · ${match.setup} bloc${match.setup > 1 ? "s" : ""} à compléter`}
            </span>
          </span>
        </label>
      )}
    </>
  );
}
