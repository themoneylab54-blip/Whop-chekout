"use client";

import { useEffect, useRef, type ComponentPropsWithoutRef, type RefObject } from "react";

/**
 * Makes a native `<details>` behave like a popover: Escape closes it and returns focus to its
 * `<summary>`, a click outside closes it (focus is moved back to the summary only when it was
 * inside the popover), and following a link inside closes it too.
 */
export function useDismissableDetails(ref: RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const summary = () => el.querySelector<HTMLElement>(":scope > summary");
    const close = (restoreFocus: boolean) => {
      if (!el.open) return;
      el.open = false;
      if (restoreFocus) summary()?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !el.open) return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    const onPointer = (e: PointerEvent) => {
      if (!el.open || el.contains(e.target as Node)) return;
      close(el.contains(document.activeElement));
    };
    const onFocusOut = (e: FocusEvent) => {
      // Tabbing out of the popover closes it (keyboard users do not leave it hanging open).
      const next = e.relatedTarget as Node | null;
      if (el.open && next && !el.contains(next)) close(false);
    };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a[href]");
      if (a && el.open && el.contains(a)) el.open = false;
    };
    el.addEventListener("keydown", onKey);
    el.addEventListener("focusout", onFocusOut);
    el.addEventListener("click", onClick);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("focusout", onFocusOut);
      el.removeEventListener("click", onClick);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [ref]);
}

/** Drop-in `<details>` with {@link useDismissableDetails} (usable from server components). */
export function PopoverDetails(props: ComponentPropsWithoutRef<"details">) {
  const ref = useRef<HTMLDetailsElement>(null);
  useDismissableDetails(ref);
  return <details ref={ref} {...props} />;
}
