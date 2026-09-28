"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * Fields that only apply to a reship ("Renvoi du colis"): hidden while the claim's solution
 * select (`selectId`) says otherwise, e.g. "Remboursement hors Whop". Laid out as if its children
 * were direct children of the surrounding grid.
 */
export function ReshipOnly({ selectId, children }: { selectId: string; children: ReactNode }) {
  const [reship, setReship] = useState(true);
  useEffect(() => {
    const select = document.getElementById(selectId) as HTMLSelectElement | null;
    if (!select) return;
    const sync = () => setReship(select.value === "reship");
    sync();
    select.addEventListener("change", sync);
    return () => select.removeEventListener("change", sync);
  }, [selectId]);
  return (
    <div className={reship ? "contents" : "hidden"} data-reship-only>
      {children}
    </div>
  );
}
