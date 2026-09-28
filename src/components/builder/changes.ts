import { isFixedSection, type Block, type Layout, type Theme } from "@/lib/layout";

/** Merchant wording of theme settings, for the "what will be published" summary. */
const THEME_LABELS: Partial<Record<keyof Theme, string>> = {
  language: "langue",
  font: "police",
  headingFont: "police des titres",
  fontScale: "taille du texte",
  radius: "arrondis",
  accentColor: "couleur principale",
  accentColor2: "dégradé des boutons",
  textColor: "couleur du texte",
  borderColor: "couleur des bordures",
  buttonShape: "forme des boutons",
  buttonShadow: "ombre des boutons",
  inputStyle: "style des champs",
  headerBackground: "fond de l'en-tête",
  headerBorder: "ligne de l'en-tête",
  summarySide: "côté du récapitulatif",
  summaryImages: "images du récapitulatif",
  contentWidth: "largeur du contenu",
  pageBackground: "fond de page",
  formBackground: "fond du formulaire",
  summaryBackground: "fond du récapitulatif",
  storeName: "nom de la boutique",
  showStoreName: "nom dans l'en-tête",
  headerAlign: "alignement de l'en-tête",
  logoUrl: "logo",
  logoHeight: "taille du logo",
  headerMode: "contenu de l'en-tête",
  bannerUrl: "bannière",
  bannerHeight: "hauteur de la bannière",
  bannerAuto: "proportions de la bannière",
  bannerFit: "cadrage de la bannière",
  bannerBackground: "fond de la bannière",
  bannerLink: "lien de la bannière",
  bannerRatio: "format de la bannière",
  trustLine: "ligne de confiance",
  expressCheckout: "paiement express",
  expressMethods: "boutons de paiement express",
  payButtonText: "texte du bouton Payer",
  policyLinks: "liens légaux",
  requireTerms: "case CGV",
  termsUrl: "lien des CGV",
  vatNote: "mention TVA",
  withdrawalNotice: "droit de rétractation",
};

/** Fixed sections are matched by type: their ids may differ between two loads of old data. */
const keyOf = (b: Block) => (isFixedSection(b.type) ? `type:${b.type}` : b.id);
// `sample` and `i18n` change what buyers see (examples hidden, translations), so they count too.
const content = (b: Block) => JSON.stringify([b.props, b.style, b.hidden, b.placement, b.position, b.sample ?? null, b.i18n ?? null]);

export type LayoutDiff = { added: number; removed: number; modified: number; reordered: boolean };

export function diffLayout(draft: Layout, published: Layout): LayoutDiff {
  const before = new Map(published.blocks.map((b) => [keyOf(b), b]));
  const after = new Map(draft.blocks.map((b) => [keyOf(b), b]));
  let added = 0;
  let modified = 0;
  for (const [k, b] of after) {
    const old = before.get(k);
    if (!old) added += 1;
    else if (content(old) !== content(b)) modified += 1;
  }
  const removed = [...before.keys()].filter((k) => !after.has(k)).length;
  const common = (list: Block[], other: Map<string, Block>) => list.map(keyOf).filter((k) => other.has(k));
  const reordered = common(draft.blocks, before).join("|") !== common(published.blocks, after).join("|");
  return { added, removed, modified, reordered };
}

export function diffTheme(draft: Theme, published: Theme): string[] {
  return (Object.keys(draft) as (keyof Theme)[])
    // The last applied template is builder bookkeeping ("Actuel" badge), not a change buyers see.
    .filter((k) => k !== "appliedTemplates" && JSON.stringify(draft[k]) !== JSON.stringify(published[k]))
    .map((k) => THEME_LABELS[k] ?? String(k));
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** "3 blocs modifiés · 1 ajouté · ordre" — empty when nothing changed. */
export function describeLayoutDiff(d: LayoutDiff): string {
  const parts = [
    d.modified ? plural(d.modified, "bloc modifié", "blocs modifiés") : null,
    d.added ? plural(d.added, "ajouté", "ajoutés") : null,
    d.removed ? plural(d.removed, "supprimé", "supprimés") : null,
    d.reordered ? "ordre changé" : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

/** Theme changes as a short list: the first three by name, then "+N réglages". */
export function describeThemeDiff(keys: string[]): string {
  if (keys.length === 0) return "";
  const shown = keys.slice(0, 3).join(", ");
  return keys.length > 3 ? `${shown} +${keys.length - 3} réglage${keys.length - 3 > 1 ? "s" : ""}` : shown;
}
