"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Label, Select } from "@/components/ui";

/** Shipping rate type: home delivery or relay point (needs the Mondial Relay credentials at the top of Livraison). */
export function RateKindField({ id, defaultValue, pickupReady, settingsHref }: { id: string; defaultValue: string; pickupReady: boolean; settingsHref: string }) {
  const [kind, setKind] = useState(defaultValue);
  const ref = useRef<HTMLSelectElement>(null);
  const warnId = `${id}-warn`;

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const onReset = () => setKind(defaultValue);
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [defaultValue]);

  const warn = kind === "pickup" && !pickupReady;
  return (
    <div>
      <Label htmlFor={id} hint="Point relais : le client choisit un point Mondial Relay au checkout">
        Type
      </Label>
      <Select ref={ref} id={id} name="kind" defaultValue={defaultValue} onChange={(e) => setKind(e.target.value)} aria-describedby={warn ? warnId : undefined}>
        <option value="home">Livraison à domicile</option>
        <option value="pickup">Point relais</option>
      </Select>
      {warn && (
        <p id={warnId} className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-600/20">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Mondial Relay n&apos;est pas configuré : ajoutez votre code enseigne et votre clé dans{" "}
            <Link href={settingsHref} className="font-medium underline">
              Point relais (Mondial Relay)
            </Link>
            , en haut de cette page, avant d&apos;enregistrer ce tarif.
          </span>
        </p>
      )}
    </div>
  );
}
