import type { CSSProperties } from "react";
import {
  Award,
  BadgeCheck,
  Clock,
  CreditCard,
  Gift,
  Globe,
  Headphones,
  Heart,
  Leaf,
  Lock,
  Package,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Star,
  ThumbsUp,
  Truck,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { IconKey } from "@/lib/layout";

export const ICONS: Record<IconKey, LucideIcon> = {
  shield: ShieldCheck,
  truck: Truck,
  lock: Lock,
  heart: Heart,
  check: BadgeCheck,
  refresh: RefreshCw,
  star: Star,
  gift: Gift,
  clock: Clock,
  package: Package,
  sparkles: Sparkles,
  leaf: Leaf,
  support: Headphones,
  card: CreditCard,
  zap: Zap,
  award: Award,
  thumbs: ThumbsUp,
  users: Users,
  globe: Globe,
  return: RotateCcw,
};

export const ICON_LABELS: Record<IconKey, string> = {
  shield: "Bouclier",
  truck: "Livraison",
  lock: "Cadenas",
  heart: "Cœur",
  check: "Validé",
  refresh: "Actualiser",
  star: "Étoile",
  gift: "Cadeau",
  clock: "Horloge",
  package: "Colis",
  sparkles: "Nouveauté",
  leaf: "Écologique",
  support: "Support",
  card: "Carte bancaire",
  zap: "Rapide",
  award: "Récompense",
  thumbs: "Pouce",
  users: "Communauté",
  globe: "International",
  return: "Retour",
};

export function isIconKey(value: string): value is IconKey {
  return value in ICONS;
}

/**
 * A glossy "3D" icon tile: layered gradient, inner highlight and soft drop shadow,
 * tinted with `color` (defaults to the checkout accent via CSS variable).
 */
export function IconTile({
  icon,
  size = 40,
  color,
  className = "",
}: {
  icon: LucideIcon;
  size?: number;
  color?: string;
  className?: string;
}) {
  const Icon = icon;
  const tint = color ?? "var(--accent, #4f46e5)";
  const style = {
    width: size,
    height: size,
    "--tint": tint,
    background: `linear-gradient(145deg, color-mix(in srgb, var(--tint) 16%, white) 0%, color-mix(in srgb, var(--tint) 30%, white) 100%)`,
    boxShadow: `inset 0 1px 0 rgba(255,255,255,.9), inset 0 -2px 4px color-mix(in srgb, var(--tint) 18%, transparent), 0 6px 14px -6px color-mix(in srgb, var(--tint) 55%, transparent), 0 1px 2px rgba(15,23,42,.08)`,
  } as CSSProperties;
  return (
    <span className={`relative inline-flex shrink-0 items-center justify-center rounded-[28%] ${className}`} style={style} aria-hidden>
      <span className="pointer-events-none absolute inset-x-[12%] top-[6%] h-[38%] rounded-full bg-gradient-to-b from-white/80 to-white/0" />
      <Icon
        className="relative"
        style={{ width: size * 0.5, height: size * 0.5, color: `color-mix(in srgb, var(--tint) 88%, black)`, filter: "drop-shadow(0 1px 0 rgba(255,255,255,.6))" }}
        strokeWidth={2.1}
      />
    </span>
  );
}

/** Renders an IconKey with Lucide, or a legacy emoji as plain text. */
export function BlockIcon({ value, size = 20, className = "" }: { value: string; size?: number; className?: string }) {
  if (isIconKey(value)) {
    const Icon = ICONS[value];
    return <Icon className={className} style={{ width: size, height: size }} strokeWidth={2} aria-hidden />;
  }
  return (
    <span className={className} style={{ fontSize: size * 0.9 }} aria-hidden>
      {value}
    </span>
  );
}
