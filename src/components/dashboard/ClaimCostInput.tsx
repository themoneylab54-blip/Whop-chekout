"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { centsToField, claimCostEstimate, type ClaimCostItem } from "@/lib/claim-cost";
import { inputClass } from "@/components/ui";

/**
 * "Coût pour vous" of a claim, prefilled with the reship's cost (selected replacement items at their
 * purchase cost + the carrier cost), recomputed when the merchant ticks items, until they type their
 * own amount. With "Remboursement hors Whop" selected, prefilled with the amount still paid.
 */
export function ClaimCostInput({
  id,
  label,
  hint,
  kindSelectId,
  items,
  carrierCents,
  refundCents,
  currency,
}: {
  id: string;
  label: ReactNode;
  /** Shown under the label while there is nothing to prefill. */
  hint?: string;
  kindSelectId: string;
  items: ClaimCostItem[];
  carrierCents: number | null;
  refundCents: number;
  currency: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const typed = useRef(false);
  const [note, setNote] = useState<string>("");

  useEffect(() => {
    const input = ref.current;
    const form = input?.form;
    if (!input || !form) return;
    const kind = document.getElementById(kindSelectId) as HTMLSelectElement | null;
    const money = (c: number) => `${centsToField(c)} ${currency}`;
    const update = () => {
      const boxes = [...form.querySelectorAll<HTMLInputElement>('input[name="rline"]')];
      const selected = boxes.length ? new Set(boxes.filter((b) => b.checked).map((b) => b.value)) : null;
      if (kind && kind.value !== "reship") {
        if (!typed.current) input.value = refundCents > 0 ? centsToField(refundCents) : "";
        setNote(refundCents > 0 ? `Pré-rempli : montant payé restant (${money(refundCents)}), à ajuster.` : "");
        return;
      }
      const e = claimCostEstimate(items, selected, carrierCents);
      if (!typed.current) input.value = e.cents > 0 ? centsToField(e.cents) : "";
      setNote(
        e.cents > 0 || e.missing
          ? `Pré-rempli : articles ${money(e.itemsCents)} + transport ${carrierCents == null ? "inconnu" : money(e.carrierCents)}${
              e.missing ? ` · ${e.missing} article(s) sans coût d'achat, non compté(s)` : ""
            }. Modifiable.`
          : "",
      );
    };
    const onInput = () => (typed.current = true);
    update();
    input.addEventListener("input", onInput);
    form.addEventListener("change", update);
    return () => {
      input.removeEventListener("input", onInput);
      form.removeEventListener("change", update);
    };
  }, [items, carrierCents, refundCents, currency, kindSelectId]);

  // The prefill note sits under the label (not under the field): the field stays aligned with its row.
  return (
    <>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium text-zinc-800">
        {label}
        {(note || hint) && (
          <span id={`${id}-prefill`} className="mt-0.5 block text-xs font-normal text-zinc-600" aria-live="polite">
            {note || hint}
          </span>
        )}
      </label>
      <input
        ref={ref}
        id={id}
        name="cost"
        inputMode="decimal"
        required
        placeholder="ex. 18,50"
        autoComplete="off"
        className={inputClass}
      />
    </>
  );
}
