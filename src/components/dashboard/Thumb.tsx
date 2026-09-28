"use client";

import { useState } from "react";
import { ImageOff, Package } from "lucide-react";

/** Product image tile; a missing or broken image falls back to a neutral icon tile. */
export function Thumb({ src, size = 36, className = "" }: { src: string | null | undefined; size?: number; className?: string }) {
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const broken = !!src && brokenSrc === src;
  if (!src || broken)
    return (
      <span
        className={`flex shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-400 ring-1 ring-zinc-900/5 ${className}`}
        style={{ width: size, height: size }}
        aria-hidden
      >
        {src ? <ImageOff className="h-4 w-4" /> : <Package className="h-4 w-4" />}
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setBrokenSrc(src)}
      // The image may have failed before hydration attached onError.
      ref={(img) => {
        if (img?.complete && img.naturalWidth === 0) setBrokenSrc(src);
      }}
      className={`shrink-0 rounded-lg bg-zinc-100 object-cover ring-1 ring-zinc-900/5 ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
