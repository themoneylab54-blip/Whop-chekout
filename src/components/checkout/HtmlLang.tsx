"use client";

import { useEffect } from "react";

/**
 * Keeps `<html lang>` on the checkout language after client-side navigations (the root
 * layout is shared with the French dashboard). The first paint is handled by the inline
 * script the checkout pages render on the server (see `htmlLangScript`).
 */
export function HtmlLang({ lang }: { lang: string }) {
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return null;
}
