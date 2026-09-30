"use client";

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { isEditForm, lockEditForms } from "./readOnlyDom";

const ReadOnlyContext = createContext(false);

/** The signed-in user may only view this store (viewer role): hide or disable what edits it. */
export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}

/**
 * The store pages' content. Read-only (viewers), every form that changes something gets its
 * controls locked as it appears (see lockEditForms) and can't be submitted; navigation (links,
 * GET filters, search) is untouched. Server actions refuse viewers anyway: this spares them a form
 * that bounces after they filled it in.
 */
export function ReadOnlyScope({ readOnly, className, children }: { readOnly: boolean; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!readOnly || !root) return;
    lockEditForms(root);
    // Forms rendered later (tabs, disclosures, client state) and props re-enabling a control.
    const observer = new MutationObserver(() => lockEditForms(root));
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "readonly", "method", "action"] });
    // Enter in a read-only field still submits a form: stopped here.
    const onSubmit = (e: SubmitEvent) => {
      if (e.target instanceof HTMLFormElement && isEditForm(e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    root.addEventListener("submit", onSubmit, true);
    return () => {
      observer.disconnect();
      root.removeEventListener("submit", onSubmit, true);
    };
  }, [readOnly]);
  return (
    <ReadOnlyContext.Provider value={readOnly}>
      <div ref={ref} className={className} data-readonly={readOnly ? "" : undefined}>
        {children}
      </div>
    </ReadOnlyContext.Provider>
  );
}
