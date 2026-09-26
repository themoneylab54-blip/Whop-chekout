"use client";

import type { ReactNode } from "react";
import type { Block, BlockOf, BlockStyle } from "@/lib/layout";

/* ------------------------------------------------------------------ */
/* Small controlled inputs                                             */
/* ------------------------------------------------------------------ */

const input =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10";

export function F({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-zinc-500">{hint}</span>}
    </label>
  );
}

export function Text({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input className={input} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

export function Area({ value, onChange, rows = 3 }: { value: string; onChange: (v: string) => void; rows?: number }) {
  return <textarea className={input} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />;
}

export function Num({ value, onChange, min, max, step = 1 }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <input
      type="number"
      className={input}
      value={Number.isFinite(value) ? value : 0}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const n = Number(e.target.value);
        onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, Number.isFinite(n) ? n : 0)));
      }}
    />
  );
}

export function Pick<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <select className={input} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-md border border-zinc-300 bg-white p-0.5">
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`flex-1 rounded px-2 py-1 text-xs ${value === v ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export function ColorInput({ value, onChange, allowEmpty = true }: { value: string; onChange: (v: string) => void; allowEmpty?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value || "#ffffff"}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-10 cursor-pointer rounded border border-zinc-300 bg-white p-0.5"
      />
      <input className={`${input} font-mono text-xs`} value={value} placeholder="par défaut" onChange={(e) => onChange(e.target.value)} />
      {allowEmpty && value && (
        <button type="button" onClick={() => onChange("")} className="text-xs text-zinc-500 underline">
          effacer
        </button>
      )}
    </div>
  );
}

function ListEditor<T>({
  items,
  onChange,
  render,
  create,
  addLabel,
  max,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  render: (item: T, set: (v: T) => void, i: number) => ReactNode;
  create: () => T;
  addLabel: string;
  max: number;
}) {
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="relative space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-2.5 pr-8">
          {render(it, (v) => onChange(items.map((x, j) => (j === i ? v : x))), i)}
          <button
            type="button"
            aria-label="Retirer"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            className="absolute top-2 right-2 text-zinc-400 hover:text-red-600"
          >
            ✕
          </button>
        </div>
      ))}
      {items.length < max && (
        <button type="button" onClick={() => onChange([...items, create()])} className="text-xs font-medium text-zinc-900 underline">
          + {addLabel}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Content fields per block type                                       */
/* ------------------------------------------------------------------ */

export function BlockContentEditor({ block, onChange }: { block: Block; onChange: (b: Block) => void }) {
  function props<T extends Block["type"]>(b: BlockOf<T>, patch: Partial<BlockOf<T>["props"]>) {
    onChange({ ...b, props: { ...b.props, ...patch } } as Block);
  }

  switch (block.type) {
    case "contact":
    case "delivery":
    case "shipping_method":
    case "payment":
    case "order_addons":
      return (
        <div className="space-y-3">
          <F label="Titre" hint="Vide = titre traduit par défaut">
            <Text value={block.props.title} onChange={(title) => props(block, { title })} />
          </F>
          {block.type === "shipping_method" && <p className="text-[11px] text-zinc-500">Les tarifs viennent de la page Livraison.</p>}
          {block.type === "order_addons" && <p className="text-[11px] text-zinc-500">Les options viennent de la page Promos &amp; options.</p>}
          {block.type === "payment" && <p className="text-[11px] text-zinc-500">Le formulaire de paiement Whop (carte, Apple Pay, etc.) s&apos;affiche ici.</p>}
        </div>
      );
    case "text":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.heading} onChange={(heading) => props(block, { heading })} />
          </F>
          <F label="Texte">
            <Area value={block.props.body} onChange={(body) => props(block, { body })} />
          </F>
        </div>
      );
    case "image":
      return (
        <div className="space-y-3">
          <F label="URL de l'image">
            <Text value={block.props.url} placeholder="https://…" onChange={(url) => props(block, { url })} />
          </F>
          <F label="Texte alternatif">
            <Text value={block.props.alt} onChange={(alt) => props(block, { alt })} />
          </F>
          <F label="Taille">
            <Segmented
              value={block.props.size}
              options={[
                ["sm", "S"],
                ["md", "M"],
                ["lg", "L"],
                ["full", "100 %"],
              ]}
              onChange={(size) => props(block, { size })}
            />
          </F>
        </div>
      );
    case "testimonial":
      return (
        <div className="space-y-3">
          <F label="Citation">
            <Area value={block.props.quote} onChange={(quote) => props(block, { quote })} />
          </F>
          <F label="Auteur" hint="Utilisez de vrais avis clients : les faux avis sont interdits (directive Omnibus).">
            <Text value={block.props.author} onChange={(author) => props(block, { author })} />
          </F>
          <F label="Photo (URL, facultatif)">
            <Text value={block.props.photoUrl} onChange={(photoUrl) => props(block, { photoUrl })} />
          </F>
          <F label="Étoiles">
            <Num value={block.props.stars} min={1} max={5} onChange={(stars) => props(block, { stars })} />
          </F>
        </div>
      );
    case "rating":
      return (
        <div className="grid grid-cols-2 gap-3">
          <F label="Note /5">
            <Num value={block.props.score} min={0} max={5} step={0.1} onChange={(score) => props(block, { score })} />
          </F>
          <F label="Nombre d'avis">
            <Num value={block.props.count} min={0} onChange={(count) => props(block, { count })} />
          </F>
          <div className="col-span-2">
            <F label="Libellé" hint="Reprenez la note réelle de votre outil d'avis (Judge.me, Loox, Trustpilot…).">
              <Text value={block.props.label} onChange={(label) => props(block, { label })} />
            </F>
          </div>
        </div>
      );
    case "trust_badges":
      return (
        <ListEditor
          items={block.props.badges}
          max={8}
          addLabel="Ajouter un badge"
          create={() => ({ label: "Nouveau badge", iconUrl: "" })}
          onChange={(badges) => props(block, { badges })}
          render={(b, set) => (
            <>
              <Text value={b.label} onChange={(label) => set({ ...b, label })} />
              <Text value={b.iconUrl} placeholder="Icône (URL, facultatif)" onChange={(iconUrl) => set({ ...b, iconUrl })} />
            </>
          )}
        />
      );
    case "guarantee":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} onChange={(title) => props(block, { title })} />
          </F>
          <F label="Texte">
            <Area value={block.props.text} onChange={(text) => props(block, { text })} />
          </F>
        </div>
      );
    case "faq":
      return (
        <ListEditor
          items={block.props.items}
          max={20}
          addLabel="Ajouter une question"
          create={() => ({ q: "Nouvelle question ?", a: "Réponse." })}
          onChange={(items) => props(block, { items })}
          render={(it, set) => (
            <>
              <Text value={it.q} onChange={(q) => set({ ...it, q })} />
              <Area value={it.a} rows={2} onChange={(a) => set({ ...it, a })} />
            </>
          )}
        />
      );
    case "value_props":
      return (
        <ListEditor
          items={block.props.items}
          max={8}
          addLabel="Ajouter un argument"
          create={() => ({ icon: "⭐", label: "Argument" })}
          onChange={(items) => props(block, { items })}
          render={(it, set) => (
            <div className="flex gap-2">
              <input className={`${input} w-14 text-center`} value={it.icon} maxLength={8} onChange={(e) => set({ ...it, icon: e.target.value })} />
              <Text value={it.label} onChange={(label) => set({ ...it, label })} />
            </div>
          )}
        />
      );
    case "payment_icons": {
      const all = ["visa", "mastercard", "amex", "applepay", "gpay", "sepa", "crypto"] as const;
      return (
        <div className="space-y-3">
          <F label="Libellé (facultatif)">
            <Text value={block.props.label} onChange={(label) => props(block, { label })} />
          </F>
          <div className="flex flex-wrap gap-1.5">
            {all.map((m) => {
              const on = block.props.methods.includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => props(block, { methods: on ? block.props.methods.filter((x) => x !== m) : [...block.props.methods, m] })}
                  className={`rounded-full border px-2.5 py-1 text-xs ${on ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 text-zinc-600"}`}
                >
                  {m}
                </button>
              );
            })}
          </div>
        </div>
      );
    }
    case "announcement":
      return (
        <F label="Texte de l'annonce">
          <Area value={block.props.text} rows={2} onChange={(text) => props(block, { text })} />
        </F>
      );
    case "countdown":
      return (
        <div className="space-y-3">
          <F label="Libellé">
            <Text value={block.props.label} onChange={(label) => props(block, { label })} />
          </F>
          <F label="Fin de l'offre" hint="Une vraie date de fin : le minuteur disparaît ensuite (pas de faux compte à rebours qui se relance).">
            <input
              type="datetime-local"
              className={input}
              value={toLocalInput(block.props.endsAt)}
              onChange={(e) => props(block, { endsAt: e.target.value ? new Date(e.target.value).toISOString() : "" })}
            />
          </F>
        </div>
      );
    case "low_stock":
      return (
        <div className="space-y-3">
          <F label="Message" hint="{n} = quantité restante réelle (inventaire Shopify)">
            <Text value={block.props.message} onChange={(message) => props(block, { message })} />
          </F>
          <F label="Afficher quand le stock est ≤">
            <Num value={block.props.threshold} min={1} max={100} onChange={(threshold) => props(block, { threshold })} />
          </F>
        </div>
      );
    case "why_us":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} onChange={(title) => props(block, { title })} />
          </F>
          <ListEditor
            items={block.props.rows}
            max={8}
            addLabel="Ajouter une ligne"
            create={() => ({ icon: "check" as const, title: "Titre", text: "Texte" })}
            onChange={(rows) => props(block, { rows })}
            render={(r, set) => (
              <>
                <Pick
                  value={r.icon}
                  options={[
                    ["shield", "🛡️ Bouclier"],
                    ["star", "⭐ Étoile"],
                    ["truck", "🚚 Camion"],
                    ["lock", "🔒 Cadenas"],
                    ["heart", "❤️ Cœur"],
                    ["check", "✅ Coche"],
                    ["refresh", "🔄 Retour"],
                  ]}
                  onChange={(icon) => set({ ...r, icon })}
                />
                <Text value={r.title} onChange={(title) => set({ ...r, title })} />
                <Text value={r.text} onChange={(text) => set({ ...r, text })} />
              </>
            )}
          />
        </div>
      );
  }
}

function toLocalInput(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/* Style panel                                                         */
/* ------------------------------------------------------------------ */

export function StyleEditor({ style, onChange }: { style: BlockStyle; onChange: (s: BlockStyle) => void }) {
  const set = <K extends keyof BlockStyle>(k: K, v: BlockStyle[K]) => onChange({ ...style, [k]: v });
  return (
    <div className="grid grid-cols-2 gap-3">
      <F label="Espacement">
        <Pick value={style.spacing} options={[["default", "Défaut"], ["none", "Aucun"], ["sm", "Petit"], ["md", "Moyen"], ["lg", "Grand"]]} onChange={(v) => set("spacing", v)} />
      </F>
      <F label="Alignement">
        <Pick value={style.align} options={[["default", "Défaut"], ["left", "Gauche"], ["center", "Centre"], ["right", "Droite"]]} onChange={(v) => set("align", v)} />
      </F>
      <F label="Taille du texte">
        <Pick value={style.textSize} options={[["default", "Défaut"], ["sm", "Petit"], ["md", "Moyen"], ["lg", "Grand"]]} onChange={(v) => set("textSize", v)} />
      </F>
      <F label="Couleur du texte">
        <Pick value={style.textColor} options={[["default", "Défaut"], ["muted", "Atténué"], ["brand", "Marque"], ["white", "Blanc"]]} onChange={(v) => set("textColor", v)} />
      </F>
      <F label="Fond">
        <Pick value={style.background} options={[["none", "Aucun"], ["light", "Clair"], ["brand", "Teinte marque"], ["dark", "Sombre"]]} onChange={(v) => set("background", v)} />
      </F>
      <F label="Séparateur">
        <Pick value={style.divider} options={[["none", "Aucun"], ["top", "Haut"], ["bottom", "Bas"], ["both", "Haut et bas"]]} onChange={(v) => set("divider", v)} />
      </F>
      <label className="col-span-2 flex items-center gap-2 text-xs font-medium text-zinc-700">
        <input type="checkbox" checked={style.card} onChange={(e) => set("card", e.target.checked)} /> Encadré (carte)
      </label>
      <div className="col-span-2">
        <F label="Fond personnalisé">
          <ColorInput value={style.customBackground} onChange={(v) => set("customBackground", v)} />
        </F>
      </div>
      <div className="col-span-2">
        <F label="Texte personnalisé">
          <ColorInput value={style.customText} onChange={(v) => set("customText", v)} />
        </F>
      </div>
    </div>
  );
}
