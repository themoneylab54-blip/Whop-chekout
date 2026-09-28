"use client";

import { useState, type ReactNode } from "react";
import { ICON_KEYS, type Block, type BlockOf, type BlockStyle, type IconKey } from "@/lib/layout";
import { X } from "lucide-react";
import { BlockIcon, ICON_LABELS, isIconKey } from "@/components/icons";

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

const isHttpUrl = (v: string) => /^https?:\/\/[^\s]+\.[^\s]+/i.test(v) && URL.canParse(v);

/**
 * URL field that only commits a value the checkout accepts (http(s) or empty), so one
 * half-typed address can never make the whole design fail to save.
 */
export function UrlText({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  const invalid = draft.trim() !== "" && !isHttpUrl(draft.trim());
  return (
    <div>
      <input
        className={`${input} ${invalid ? "border-amber-400 focus:border-amber-500" : ""}`}
        value={draft}
        placeholder={placeholder ?? "https://…"}
        inputMode="url"
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          if (v.trim() === "" || isHttpUrl(v.trim())) onChange(v.trim());
        }}
        onBlur={() => {
          if (invalid) setDraft(value);
        }}
      />
      {invalid && <p className="mt-1 text-[11px] text-amber-700">Adresse complète attendue, commençant par https://</p>}
    </div>
  );
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

/** "#abc" → "#aabbcc"; null when not a hex color. */
function normalizeHex(v: string): string | null {
  const t = v.trim();
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(t);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return `#${h.toLowerCase()}`;
}

/** Color picker + hex field. The text field is a free draft; only valid colors are committed. */
export function ColorInput({ value, onChange, allowEmpty = true }: { value: string; onChange: (v: string) => void; allowEmpty?: boolean }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value || "#ffffff"}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-10 cursor-pointer rounded border border-zinc-300 bg-white p-0.5"
      />
      <input
        className={`${input} font-mono text-xs`}
        value={draft}
        placeholder="par défaut"
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          const hex = normalizeHex(v);
          if (hex && hex.length === 7 && v.replace("#", "").length === 6) onChange(hex);
          else if (allowEmpty && v.trim() === "") onChange("");
        }}
        onBlur={() => {
          const hex = normalizeHex(draft);
          if (hex) onChange(hex);
          else if (!(allowEmpty && draft.trim() === "")) setDraft(value);
        }}
      />
      {allowEmpty && value && (
        <button type="button" onClick={() => onChange("")} className="text-xs text-zinc-500 underline">
          effacer
        </button>
      )}
    </div>
  );
}

/** Grid of Lucide icons (replaces the old emoji inputs). */
export function IconPicker({ value, onChange }: { value: string; onChange: (v: IconKey) => void }) {
  return (
    <div className="grid grid-cols-10 gap-1">
      {ICON_KEYS.map((k) => (
        <button
          key={k}
          type="button"
          title={ICON_LABELS[k]}
          aria-label={ICON_LABELS[k]}
          aria-pressed={value === k}
          onClick={() => onChange(k)}
          className={`flex aspect-square items-center justify-center rounded-md border transition ${
            value === k ? "border-indigo-400 bg-indigo-50 text-indigo-600" : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300 hover:text-zinc-800"
          }`}
        >
          <BlockIcon value={k} size={14} />
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs font-medium text-zinc-700">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-3.5 w-3.5 accent-zinc-900" />
      {label}
    </label>
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
            <X className="h-3.5 w-3.5" />
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
            <UrlText value={block.props.url} placeholder="https://…" onChange={(url) => props(block, { url })} />
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
            <UrlText value={block.props.photoUrl} onChange={(photoUrl) => props(block, { photoUrl })} />
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
              <UrlText value={b.iconUrl} placeholder="Icône (URL, facultatif)" onChange={(iconUrl) => set({ ...b, iconUrl })} />
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
          create={() => ({ icon: "star", label: "Argument" })}
          onChange={(items) => props(block, { items })}
          render={(it, set) => (
            <>
              <Text value={it.label} onChange={(label) => set({ ...it, label })} />
              <IconPicker value={isIconKey(it.icon) ? it.icon : ""} onChange={(icon) => set({ ...it, icon })} />
            </>
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
                <IconPicker value={r.icon} onChange={(icon) => set({ ...r, icon })} />
                <Text value={r.title} onChange={(title) => set({ ...r, title })} />
                <Text value={r.text} onChange={(text) => set({ ...r, text })} />
              </>
            )}
          />
        </div>
      );
    case "free_shipping_bar":
      return (
        <div className="space-y-3">
          <F label="Message" hint="{amount} = montant restant">
            <Text value={block.props.message} onChange={(message) => props(block, { message })} />
          </F>
          <F label="Message une fois atteint">
            <Text value={block.props.success} onChange={(success) => props(block, { success })} />
          </F>
          <F label="Seuil (€)" hint="0 = le seuil « Offert dès » de vos tarifs de livraison">
            <Num value={block.props.threshold} min={0} max={100000} onChange={(threshold) => props(block, { threshold })} />
          </F>
        </div>
      );
    case "delivery_estimate":
      return (
        <div className="space-y-3">
          <F label="Libellé">
            <Text value={block.props.label} onChange={(label) => props(block, { label })} />
          </F>
          <div className="grid grid-cols-2 gap-3">
            <F label="Délai min (jours)">
              <Num value={block.props.minDays} min={0} max={60} onChange={(minDays) => props(block, { minDays })} />
            </F>
            <F label="Délai max (jours)">
              <Num value={block.props.maxDays} min={0} max={90} onChange={(maxDays) => props(block, { maxDays })} />
            </F>
          </div>
          <Toggle label="Jours ouvrés uniquement (hors week-end)" checked={block.props.businessDays} onChange={(businessDays) => props(block, { businessDays })} />
          <Toggle label="Afficher la frise Commande → Livraison" checked={block.props.showTimeline} onChange={(showTimeline) => props(block, { showTimeline })} />
        </div>
      );
    case "reviews":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} onChange={(title) => props(block, { title })} />
          </F>
          <F label="Affichage">
            <Segmented value={block.props.layout} options={[["carousel", "Carrousel"], ["stack", "Liste"]]} onChange={(layout) => props(block, { layout })} />
          </F>
          <p className="text-[11px] text-zinc-500">Utilisez de vrais avis clients : les faux avis sont interdits (directive Omnibus).</p>
          <ListEditor
            items={block.props.items}
            max={20}
            addLabel="Ajouter un avis"
            create={() => ({ name: "Prénom N.", text: "Votre avis…", stars: 5, verified: true })}
            onChange={(items) => props(block, { items })}
            render={(r, set) => (
              <>
                <Text value={r.name} onChange={(name) => set({ ...r, name })} />
                <Area value={r.text} rows={2} onChange={(text) => set({ ...r, text })} />
                <div className="flex items-center gap-3">
                  <div className="w-20">
                    <Num value={r.stars} min={1} max={5} onChange={(stars) => set({ ...r, stars })} />
                  </div>
                  <Toggle label="Achat vérifié" checked={r.verified} onChange={(verified) => set({ ...r, verified })} />
                </div>
              </>
            )}
          />
        </div>
      );
    case "comparison":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} onChange={(title) => props(block, { title })} />
          </F>
          <div className="grid grid-cols-2 gap-3">
            <F label="Colonne « nous »">
              <Text value={block.props.usLabel} onChange={(usLabel) => props(block, { usLabel })} />
            </F>
            <F label="Colonne « eux »">
              <Text value={block.props.themLabel} onChange={(themLabel) => props(block, { themLabel })} />
            </F>
          </div>
          <ListEditor
            items={block.props.rows}
            max={12}
            addLabel="Ajouter une ligne"
            create={() => ({ label: "Critère", us: true, them: false })}
            onChange={(rows) => props(block, { rows })}
            render={(r, set) => (
              <>
                <Text value={r.label} onChange={(label) => set({ ...r, label })} />
                <div className="flex gap-4">
                  <Toggle label={block.props.usLabel || "Nous"} checked={r.us} onChange={(us) => set({ ...r, us })} />
                  <Toggle label={block.props.themLabel || "Eux"} checked={r.them} onChange={(them) => set({ ...r, them })} />
                </div>
              </>
            )}
          />
        </div>
      );
    case "video":
      return (
        <div className="space-y-3">
          <F label="Lien de la vidéo" hint="YouTube, Vimeo ou fichier .mp4">
            <UrlText value={block.props.url} placeholder="https://youtube.com/watch?v=…" onChange={(url) => props(block, { url })} />
          </F>
          <F label="Légende (facultatif)">
            <Text value={block.props.caption} onChange={(caption) => props(block, { caption })} />
          </F>
        </div>
      );
    case "logos":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} onChange={(title) => props(block, { title })} />
          </F>
          <ListEditor
            items={block.props.logos}
            max={10}
            addLabel="Ajouter un logo"
            create={() => ({ imageUrl: "", alt: "" })}
            onChange={(logos) => props(block, { logos })}
            render={(l, set) => (
              <>
                <UrlText value={l.imageUrl} placeholder="URL du logo (PNG/SVG)" onChange={(imageUrl) => set({ ...l, imageUrl })} />
                <Text value={l.alt} placeholder="Nom du média" onChange={(alt) => set({ ...l, alt })} />
              </>
            )}
          />
        </div>
      );
    case "stats":
      return (
        <ListEditor
          items={block.props.items}
          max={4}
          addLabel="Ajouter un chiffre"
          create={() => ({ value: "100 %", label: "Libellé" })}
          onChange={(items) => props(block, { items })}
          render={(it, set) => (
            <div className="grid grid-cols-[90px_1fr] gap-2">
              <Text value={it.value} onChange={(value) => set({ ...it, value })} />
              <Text value={it.label} onChange={(label) => set({ ...it, label })} />
            </div>
          )}
        />
      );
    case "benefits":
      return (
        <div className="space-y-3">
          <F label="Titre (facultatif)">
            <Text value={block.props.title} onChange={(title) => props(block, { title })} />
          </F>
          <F label="Colonnes">
            <Segmented value={String(block.props.columns) as "2" | "3"} options={[["2", "2"], ["3", "3"]]} onChange={(c) => props(block, { columns: c === "2" ? 2 : 3 })} />
          </F>
          <ListEditor
            items={block.props.items}
            max={9}
            addLabel="Ajouter un avantage"
            create={() => ({ icon: "sparkles" as const, title: "Avantage", text: "" })}
            onChange={(items) => props(block, { items })}
            render={(it, set) => (
              <>
                <Text value={it.title} onChange={(title) => set({ ...it, title })} />
                <Text value={it.text} placeholder="Sous-texte (facultatif)" onChange={(text) => set({ ...it, text })} />
                <IconPicker value={it.icon} onChange={(icon) => set({ ...it, icon })} />
              </>
            )}
          />
        </div>
      );
    case "secure_badge":
      return (
        <div className="space-y-3">
          <F label="Texte">
            <Text value={block.props.text} onChange={(text) => props(block, { text })} />
          </F>
          <F label="Sous-texte">
            <Text value={block.props.subtext} onChange={(subtext) => props(block, { subtext })} />
          </F>
        </div>
      );
    case "order_note":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} onChange={(title) => props(block, { title })} />
          </F>
          <F label="Texte d'exemple">
            <Text value={block.props.placeholder} onChange={(placeholder) => props(block, { placeholder })} />
          </F>
          <p className="text-[11px] text-zinc-500">La note du client est ajoutée à la commande Shopify.</p>
        </div>
      );
    case "support":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} onChange={(title) => props(block, { title })} />
          </F>
          <F label="Texte">
            <Text value={block.props.text} onChange={(text) => props(block, { text })} />
          </F>
          <F label="E-mail">
            <Text value={block.props.email} placeholder="support@maboutique.fr" onChange={(email) => props(block, { email })} />
          </F>
          <div className="grid grid-cols-2 gap-3">
            <F label="Téléphone">
              <Text value={block.props.phone} placeholder="01 23 45 67 89" onChange={(phone) => props(block, { phone })} />
            </F>
            <F label="WhatsApp">
              <Text value={block.props.whatsapp} placeholder="+33 6 12 34 56 78" onChange={(whatsapp) => props(block, { whatsapp })} />
            </F>
          </div>
        </div>
      );
    case "spacer":
      return (
        <div className="space-y-3">
          <F label={`Hauteur : ${block.props.size}px`}>
            <input type="range" min={4} max={120} value={block.props.size} onChange={(e) => props(block, { size: Number(e.target.value) })} className="w-full accent-zinc-900" />
          </F>
          <Toggle label="Afficher une ligne" checked={block.props.line} onChange={(line) => props(block, { line })} />
        </div>
      );
    case "button_link":
      return (
        <div className="space-y-3">
          <F label="Texte du bouton">
            <Text value={block.props.label} onChange={(label) => props(block, { label })} />
          </F>
          <F label="Lien">
            <UrlText value={block.props.url} placeholder="https://…" onChange={(url) => props(block, { url })} />
          </F>
          <F label="Style">
            <Segmented value={block.props.variant} options={[["solid", "Plein"], ["outline", "Contour"]]} onChange={(variant) => props(block, { variant })} />
          </F>
        </div>
      );
    case "upsell":
      return (
        <div className="space-y-3">
          <p className="rounded-lg bg-indigo-50 px-3 py-2 text-[11px] leading-relaxed text-indigo-900">
            Affichée juste après l&apos;achat. Le client accepte en un clic : Whop débite la carte enregistrée pendant le checkout et une commande Shopify
            liée est créée. Valable 1 h après le paiement. Quand une offre est active, le checkout enregistre la carte (certains moyens comme PayPal peuvent
            alors être masqués).
          </p>
          <F label="ID de variante Shopify" hint="Le numéro de la variante (ou l'URL admin …/variants/123).">
            <Text
              value={block.props.variantId}
              placeholder="44871234567890"
              onChange={(v) => props(block, { variantId: v.startsWith("gid://") ? v : (v.match(/(\d+)\D*$/)?.[1] ?? v.trim()) })}
            />
          </F>
          <div className="grid grid-cols-2 gap-2">
            <F label="Prix de l'offre">
              <Num value={block.props.price} min={0} step={0.1} onChange={(price) => props(block, { price })} />
            </F>
            <F label="Prix barré">
              <Num value={block.props.compareAt} min={0} step={0.1} onChange={(compareAt) => props(block, { compareAt })} />
            </F>
          </div>
          <F label="Bandeau">
            <Text value={block.props.badge} onChange={(badge) => props(block, { badge })} />
          </F>
          <F label="Titre">
            <Text value={block.props.title} onChange={(title) => props(block, { title })} />
          </F>
          <F label="Texte">
            <Area value={block.props.text} rows={3} onChange={(text) => props(block, { text })} />
          </F>
          <F label="Image">
            <UrlText value={block.props.imageUrl} onChange={(imageUrl) => props(block, { imageUrl })} />
          </F>
          <div className="grid grid-cols-2 gap-2">
            <F label="Bouton">
              <Text value={block.props.buttonText} onChange={(buttonText) => props(block, { buttonText })} />
            </F>
            <F label="Refus">
              <Text value={block.props.declineText} onChange={(declineText) => props(block, { declineText })} />
            </F>
          </div>
        </div>
      );
    case "coupon":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} onChange={(title) => props(block, { title })} />
          </F>
          <F label="Texte">
            <Area value={block.props.text} rows={2} onChange={(text) => props(block, { text })} />
          </F>
          <F label="Code" hint="Créez-le aussi dans Promos & options pour qu'il fonctionne.">
            <Text value={block.props.code} onChange={(code) => props(block, { code: code.toUpperCase() })} />
          </F>
        </div>
      );
    case "social":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} onChange={(title) => props(block, { title })} />
          </F>
          {(["instagram", "tiktok", "facebook", "youtube"] as const).map((k) => (
            <F key={k} label={k[0].toUpperCase() + k.slice(1)}>
              <UrlText value={block.props[k]} placeholder="https://…" onChange={(v) => props(block, { [k]: v })} />
            </F>
          ))}
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
