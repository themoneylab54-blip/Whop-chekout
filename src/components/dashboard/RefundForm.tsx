"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Input, Label, buttonClass } from "@/components/ui";
import { ConfirmButton } from "./ConfirmButton";
import { stableCents } from "./stableFormat";

/** "12,50" | "12.5" → 1250 (same rules as the server action); null when invalid. */
function parseCents(v: string): number | null {
  const t = v.replace(/\s/g, "").replace(",", ".");
  if (!t || !/^\d+(\.\d{0,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/**
 * Full or partial refund through the processor that was paid (Whop or Stripe). The confirmation dialog spells out the exact amount,
 * whether it is total or partial, and what will remain refundable. Collapsed behind a
 * « Rembourser… » button so a refund is never one stray click away.
 */
export function RefundForm({
  action,
  totalCents,
  refundedCents,
  currency,
  nonce,
  provider = "Whop",
}: {
  action: (fd: FormData) => void | Promise<void>;
  totalCents: number;
  refundedCents: number;
  currency: string;
  /** Generated per page render on the server (stable through hydration). */
  nonce: string;
  /** Processor the order was paid with ("Whop", "Stripe"): the refund goes through it. */
  provider?: "Whop" | "Stripe";
}) {
  const remaining = totalCents - refundedCents;
  const initial = (remaining / 100).toFixed(2).replace(".", ",");
  const [raw, setRaw] = useState(initial);
  const amount = parseCents(raw);
  const valid = amount != null && amount > 0 && amount <= remaining;
  const full = valid && amount === remaining;
  const money = (c: number) => stableCents(c, currency);
  const [open, setOpen] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) amountRef.current?.select();
    else if (wasOpen.current) openerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  if (!open) {
    return (
      <button ref={openerRef} type="button" onClick={() => setOpen(true)} aria-expanded={false} className={`${buttonClass("secondary")} min-h-9`}>
        <RotateCcw className="h-4 w-4" aria-hidden /> Rembourser…
      </button>
    );
  }

  return (
    <form action={action} className="space-y-3">
      {/* One key per displayed form: a double submit is deduped by the processor, two deliberate refunds aren't. */}
      <input type="hidden" name="nonce" value={nonce} />
      <div>
        <Label htmlFor="refund-amount" hint={`Maximum : ${money(remaining)}${refundedCents > 0 ? ` (déjà remboursé : ${money(refundedCents)})` : ""}`}>
          Montant à rembourser ({currency})
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            ref={amountRef}
            id="refund-amount"
            name="amount"
            inputMode="decimal"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            aria-invalid={!valid}
            aria-describedby="refund-amount-msg"
            className="w-32"
          />
          {!full && (
            <button
              type="button"
              onClick={() => setRaw(initial)}
              className="inline-flex min-h-9 items-center rounded-lg px-2.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50"
            >
              Tout rembourser
            </button>
          )}
        </div>
        <p id="refund-amount-msg" className={`mt-1.5 text-xs ${valid ? "text-zinc-500" : "text-red-600"}`} aria-live="polite">
          {valid
            ? full
              ? "Remboursement total de la commande."
              : `Remboursement partiel · il restera ${money(remaining - amount)} remboursable.`
            : `Saisissez un montant entre 0,01 et ${money(remaining).replace(/ \S+$/, "")}.`}
        </p>
      </div>
      <ConfirmButton
        disabled={!valid}
        title={valid ? `Rembourser ${money(amount)} ?` : "Rembourser ?"}
        description={
          valid ? (
            <>
              <span className="mb-2 block rounded-lg bg-zinc-50 px-3 py-2 text-zinc-800 ring-1 ring-zinc-900/5">
                <span className="flex justify-between gap-3">
                  <span>Montant payé</span>
                  <span className="tabular-nums">{money(totalCents)}</span>
                </span>
                {refundedCents > 0 && (
                  <span className="flex justify-between gap-3">
                    <span>Déjà remboursé</span>
                    <span className="tabular-nums">−{money(refundedCents)}</span>
                  </span>
                )}
                <span className="flex justify-between gap-3 font-semibold">
                  <span>{full ? "Remboursement total" : "Remboursement partiel"}</span>
                  <span className="tabular-nums">−{money(amount)}</span>
                </span>
              </span>
              Le client est remboursé via {provider}, puis la commande Shopify est mise à jour automatiquement. Un remboursement est définitif.
            </>
          ) : undefined
        }
        confirmLabel={valid ? `Rembourser ${money(amount)}` : "Rembourser"}
      >
        <RotateCcw className="h-4 w-4" aria-hidden /> Rembourser
      </ConfirmButton>
      <button type="button" onClick={() => setOpen(false)} className="ml-2 inline-flex min-h-9 items-center rounded-lg px-3 text-sm font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900">
        Annuler
      </button>
    </form>
  );
}
