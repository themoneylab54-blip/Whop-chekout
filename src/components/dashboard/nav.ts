/** Dashboard navigation, shared by the desktop sidebar and the mobile menu sheet. */
export type NavIconName =
  | "costs"
  | "overview"
  | "orders"
  | "analytics"
  | "shopify"
  | "whop"
  | "stripe"
  | "interception"
  | "design"
  | "thankyou"
  | "shipping"
  | "offers"
  | "growth"
  | "journal"
  | "settings";

export type NavItem = { path: string; label: string; icon: NavIconName; exact?: boolean };
export type NavGroup = { label: string | null; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [
      { path: "", label: "Vue d'ensemble", icon: "overview", exact: true },
      { path: "orders", label: "Commandes", icon: "orders" },
      { path: "analytics", label: "Analytics", icon: "analytics" },
      { path: "costs", label: "Coûts produits", icon: "costs" },
    ],
  },
  {
    label: "Connexions",
    items: [
      { path: "shopify", label: "Shopify", icon: "shopify" },
      { path: "whop", label: "Whop", icon: "whop" },
      { path: "stripe", label: "Stripe", icon: "stripe" },
      { path: "interception", label: "Interception", icon: "interception" },
    ],
  },
  {
    label: "Checkout",
    items: [
      { path: "builder/checkout", label: "Design du checkout", icon: "design" },
      { path: "builder/thank-you", label: "Page de remerciement", icon: "thankyou" },
      { path: "shipping", label: "Livraison", icon: "shipping" },
      { path: "offers", label: "Promos & options", icon: "offers" },
      { path: "growth", label: "Pub & pixels", icon: "growth" },
    ],
  },
  {
    label: "Compte",
    items: [
      { path: "journal", label: "Journal & santé", icon: "journal" },
      { path: "settings", label: "Réglages", icon: "settings" },
    ],
  },
];

export function navHref(base: string, item: NavItem) {
  return item.path ? `${base}/${item.path}` : base;
}

export function isActive(pathname: string, href: string, exact?: boolean) {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Sections inside pages, indexed by the ⌘K palette so "fuseau", "alertes", "litiges"… jump
 * straight to the right card (anchor or tab). `keywords` are extra search terms, unaccented.
 */
export type NavSection = { label: string; page: string; path: string; hash?: string; keywords?: string };

export const NAV_SECTIONS: NavSection[] = [
  { label: "Boutique", page: "Réglages", path: "settings", hash: "boutique", keywords: "nom devise langue" },
  { label: "Fuseau horaire", page: "Réglages", path: "settings", hash: "boutique", keywords: "timezone heure" },
  { label: "Options du checkout", page: "Réglages", path: "settings", hash: "checkout", keywords: "paiement abandon" },
  { label: "Réseau", page: "Réglages", path: "settings", hash: "reseau", keywords: "operateur e-mail reseau boutiques" },
  { label: "Marges & coûts", page: "Réglages", path: "settings", hash: "marges", keywords: "frais tva marge preparation" },
  { label: "Coûts", page: "Réglages", path: "settings", hash: "couts", keywords: "cout frais" },
  { label: "Attribution", page: "Réglages", path: "settings", hash: "attribution", keywords: "utm fenetre premier dernier clic" },
  { label: "Alertes", page: "Réglages", path: "settings", hash: "alertes", keywords: "telegram e-mail notification" },
  { label: "Litiges", page: "Réglages", path: "settings", hash: "litiges", keywords: "chargeback descripteur releve" },
  { label: "Dupliquer la boutique", page: "Réglages", path: "settings", hash: "dupliquer", keywords: "copier cloner" },
  { label: "Zone de danger", page: "Réglages", path: "settings", hash: "danger", keywords: "supprimer boutique" },
  { label: "Dépenses publicitaires", page: "Pub & pixels", path: "growth", hash: "adspend", keywords: "roas cpa meta tiktok google import csv" },
  { label: "Pixels Meta & TikTok", page: "Pub & pixels", path: "growth", keywords: "capi conversions api pixel serveur facebook" },
  { label: "Codes promo", page: "Promos & options", path: "offers", keywords: "reduction coupon remise" },
  { label: "Options au checkout (order bumps)", page: "Promos & options", path: "offers", keywords: "bump upsell" },
  { label: "Remises par quantité & cadeaux", page: "Promos & options", path: "offers", keywords: "quantite palier cadeau" },
  { label: "Point relais (Mondial Relay)", page: "Livraison", path: "shipping", keywords: "relais mondial" },
  { label: "Tarifs de livraison", page: "Livraison", path: "shipping", keywords: "frais port pays" },
  { label: "Journal des événements", page: "Journal & santé", path: "journal", hash: "evenements", keywords: "logs erreurs webhooks evenements" },
  { label: "État du système", page: "Journal & santé", path: "journal", keywords: "sante health" },
  { label: "Offres post-achat (1 clic)", page: "Shopify", path: "shopify", keywords: "upsell one click" },
  { label: "Apple Pay", page: "Whop", path: "whop", keywords: "domaine" },
  { label: "Paiements locaux & en plusieurs fois", page: "Whop", path: "whop", keywords: "klarna paypal bnpl" },
  { label: "Mode de paiement (Whop / Stripe)", page: "Stripe", path: "stripe", hash: "mode", keywords: "secours bascule failover processeur" },
  { label: "Boutons interceptés", page: "Interception", path: "interception", keywords: "bouton script theme" },
  { label: "Ventes", page: "Analytics", path: "analytics", keywords: "chiffre affaires benefice pnl" },
  { label: "Acquisition", page: "Analytics", path: "analytics?tab=acquisition", keywords: "sources campagnes utm roas" },
  { label: "Produits", page: "Analytics", path: "analytics?tab=produits", keywords: "variantes best-sellers" },
  { label: "Clients", page: "Analytics", path: "analytics?tab=clients", keywords: "cohortes ltv reachat" },
  { label: "Tests A/B", page: "Analytics", path: "analytics?tab=tests", keywords: "experience variante" },
];

export function sectionHref(base: string, s: NavSection) {
  return `${base}/${s.path}${s.hash ? `#${s.hash}` : ""}`;
}
