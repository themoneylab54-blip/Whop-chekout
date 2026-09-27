import type { CSSProperties } from "react";

/*
 * Official brand marks (Shopify bag, Whop mark) — paths from @thesvg/icons (MIT).
 * Used wherever the dashboard refers to the two platforms.
 */

type LogoProps = { className?: string; style?: CSSProperties; mono?: boolean };

export function ShopifyLogo({ className, style, mono }: LogoProps) {
  return (
    <svg viewBox="0 0 256 292" className={className} style={style} aria-hidden>
      <path
        fill={mono ? "currentColor" : "#95BF46"}
        d="M223.774 57.34c-.201-1.46-1.48-2.268-2.537-2.357-1.055-.088-23.383-1.743-23.383-1.743s-15.507-15.395-17.209-17.099c-1.703-1.703-5.029-1.185-6.32-.805-.19.056-3.388 1.043-8.678 2.68-5.18-14.906-14.322-28.604-30.405-28.604-.444 0-.901.018-1.358.044C129.31 3.407 123.644.779 118.75.779c-37.465 0-55.364 46.835-60.976 70.635-14.558 4.511-24.9 7.718-26.221 8.133-8.126 2.549-8.383 2.805-9.45 10.462C21.3 95.806.038 260.235.038 260.235l165.678 31.042 89.77-19.42S223.973 58.8 223.775 57.34zM156.49 40.848l-14.019 4.339c.005-.988.01-1.96.01-3.023 0-9.264-1.286-16.723-3.349-22.636 8.287 1.04 13.806 10.469 17.358 21.32zm-27.638-19.483c2.304 5.773 3.802 14.058 3.802 25.238 0 .572-.005 1.095-.01 1.624-9.117 2.824-19.024 5.89-28.953 8.966 5.575-21.516 16.025-31.908 25.161-35.828zm-11.131-10.537c1.617 0 3.246.549 4.805 1.622-12.007 5.65-24.877 19.88-30.312 48.297l-22.886 7.088C75.694 46.16 90.81 10.828 117.72 10.828z"
      />
      <path
        fill={mono ? "currentColor" : "#5E8E3E"}
        opacity={mono ? 0.75 : 1}
        d="M221.237 54.983c-1.055-.088-23.383-1.743-23.383-1.743s-15.507-15.395-17.209-17.099c-.637-.634-1.496-.959-2.394-1.099l-12.527 256.233 89.762-19.418S223.972 58.8 223.774 57.34c-.201-1.46-1.48-2.268-2.537-2.357"
      />
      <path
        fill={mono ? "var(--shopify-s, #fff)" : "#FFF"}
        d="M135.242 104.585l-11.069 32.926s-9.698-5.176-21.586-5.176c-17.428 0-18.305 10.937-18.305 13.693 0 15.038 39.2 20.8 39.2 56.024 0 27.713-17.577 45.558-41.277 45.558-28.44 0-42.984-17.7-42.984-17.7l7.615-25.16s14.95 12.835 27.565 12.835c8.243 0 11.596-6.49 11.596-11.232 0-19.616-32.16-20.491-32.16-52.724 0-27.129 19.472-53.382 58.778-53.382 15.145 0 22.627 4.338 22.627 4.338"
      />
    </svg>
  );
}

export function WhopLogo({ className, style, mono }: LogoProps) {
  return (
    <svg viewBox="0 0 383.2 196.4" className={className} style={style} fill={mono ? "currentColor" : "#FF6143"} aria-hidden>
      <path d="M60.9,0C35.7,0,18.4,11.1,5.2,23.5c0,0-5.3,5-5.2,5.2l55.2,55.2l55.2-55.2C99.9,14.3,80.2,0,60.9,0z" />
      <path d="M197.2,0c-25.2,0-42.5,11.1-55.7,23.5c0,0-4.8,4.9-5.1,5.2L68.2,96.9l55.1,55.1L246.6,28.7C236.1,14.3,216.5,0,197.2,0z" />
      <path d="M333.8,0c-25.2,0-42.5,11.1-55.7,23.5c0,0-5,4.9-5.2,5.2L136.4,165.2l14.4,14.4c22.3,22.3,58.9,22.3,81.3,0L383,28.7h0.2C372.8,14.3,353.1,0,333.8,0z" />
    </svg>
  );
}

export type Brand = "shopify" | "whop";

const BRAND = {
  shopify: { Logo: ShopifyLogo, tint: "#95BF46", scale: 0.56 },
  whop: { Logo: WhopLogo, tint: "#FF6143", scale: 0.62 },
} as const;

/** Glossy app-icon tile with the brand's real logo (matches IconTile's 3D look). */
export function BrandTile({ brand, size = 40, className = "" }: { brand: Brand; size?: number; className?: string }) {
  const { Logo, tint, scale } = BRAND[brand];
  const style = {
    width: size,
    height: size,
    background: `linear-gradient(145deg, #ffffff 0%, color-mix(in srgb, ${tint} 12%, white) 100%)`,
    boxShadow: `inset 0 1px 0 rgba(255,255,255,.95), inset 0 -2px 4px color-mix(in srgb, ${tint} 14%, transparent), 0 6px 14px -6px color-mix(in srgb, ${tint} 55%, transparent), 0 0 0 1px rgba(15,23,42,.06), 0 1px 2px rgba(15,23,42,.08)`,
  } as CSSProperties;
  return (
    <span className={`relative inline-flex shrink-0 items-center justify-center rounded-[28%] ${className}`} style={style} aria-hidden>
      <span className="pointer-events-none absolute inset-x-[12%] top-[6%] h-[38%] rounded-full bg-gradient-to-b from-white/80 to-white/0" />
      <Logo className="relative" style={{ width: size * scale, height: size * scale, filter: "drop-shadow(0 1px 1px rgba(15,23,42,.12))" }} />
    </span>
  );
}
