"use client";

import { useState } from "react";
import { Input, Label, Select } from "@/components/ui";

/** Protection-price test, arm B: only the fields of the chosen mode (fixed price vs % of cart).
 *  Examples are placeholders, never prefilled values: B is whatever the merchant types. */
export function ProtectionTestFields({ disabled }: { disabled?: boolean }) {
  const [mode, setMode] = useState<"fixed" | "percent">("fixed");
  return (
    <>
      <div>
        <Label htmlFor="t-prot-mode">Tarif B</Label>
        <Select id="t-prot-mode" name="priceMode" value={mode} onChange={(e) => setMode(e.target.value === "percent" ? "percent" : "fixed")} disabled={disabled}>
          <option value="fixed">Prix fixe</option>
          <option value="percent">% du panier</option>
        </Select>
      </div>
      {mode === "fixed" ? (
        <div>
          <Label htmlFor="t-prot-price">Prix fixe (€)</Label>
          <Input id="t-prot-price" name="price" inputMode="decimal" placeholder="ex. 3,90" required disabled={disabled} />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2">
            <Label htmlFor="t-prot-pct" hint="du total du panier">Pourcentage (%)</Label>
            <Input id="t-prot-pct" name="percent" inputMode="decimal" placeholder="ex. 3" required disabled={disabled} />
          </div>
          <div>
            <Label htmlFor="t-prot-min" hint="vide = aucun">Minimum (€)</Label>
            <Input id="t-prot-min" name="minPrice" inputMode="decimal" placeholder="ex. 1,90" disabled={disabled} />
          </div>
          <div>
            <Label htmlFor="t-prot-max" hint="vide = aucun">Maximum (€)</Label>
            <Input id="t-prot-max" name="maxPrice" inputMode="decimal" placeholder="ex. 9,90" disabled={disabled} />
          </div>
        </div>
      )}
    </>
  );
}
