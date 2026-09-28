"use client";

import { useCallback, useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { ImageOff } from "lucide-react";

/**
 * <img> that swaps itself for a neutral placeholder when the file can't load (deleted
 * Shopify image, hotlink protection, typo in a block URL…), instead of the browser's
 * broken-image icon. Also catches images that failed before React hydrated.
 */
export function SafeImg({
  fallback,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & {
  /** What to render instead; null hides the image entirely. Defaults to a grey tile of the same size. */
  fallback?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const [src, setSrc] = useState(props.src);
  if (props.src !== src) {
    setSrc(props.src);
    setFailed(false);
  }
  const ref = useCallback((el: HTMLImageElement | null) => {
    // The error event may have fired before hydration: check the loaded state once.
    if (el && el.complete && el.naturalWidth === 0 && el.getAttribute("src")) setFailed(true);
  }, []);
  if (failed || !props.src) {
    if (fallback !== undefined) return <>{fallback}</>;
    return (
      <span
        role={props.alt ? "img" : undefined}
        aria-label={props.alt || undefined}
        aria-hidden={props.alt ? undefined : true}
        className={`${props.className ?? ""} inline-flex items-center justify-center bg-neutral-100 text-neutral-400`}
        style={{ width: props.width ? Number(props.width) : undefined, height: props.height ? Number(props.height) : undefined, ...props.style }}
      >
        <ImageOff className="h-1/3 max-h-6 w-1/3 max-w-6" aria-hidden />
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  return <img {...props} ref={ref} onError={() => setFailed(true)} />;
}
