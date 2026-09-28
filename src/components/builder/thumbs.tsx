import type { CSSProperties, ReactNode } from "react";
import type { BlockType } from "@/lib/layout";
import { renderedColumns, type Spec } from "./templates";

/*
 * Tiny schematic previews (no text, no real content): enough to recognise a block or a
 * template at a glance in the library and the templates menu. Purely decorative.
 */

const bar = (w: string, cls = "bg-zinc-300") => <span className={`block h-[3px] rounded-full ${cls}`} style={{ width: w }} />;

function Frame({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span aria-hidden className={`flex h-11 w-16 shrink-0 flex-col justify-center gap-1 overflow-hidden rounded-lg bg-white p-1.5 ring-1 ring-zinc-200 ${className}`}>
      {children}
    </span>
  );
}

function Tiles({ n = 3, round = false }: { n?: number; round?: boolean }) {
  return (
    <span className="flex justify-between gap-1">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="flex flex-1 flex-col items-center gap-0.5">
          <span className={`h-2.5 w-2.5 ${round ? "rounded-full" : "rounded-[3px]"} bg-indigo-200`} />
          {bar("80%")}
        </span>
      ))}
    </span>
  );
}

function StarsRow() {
  return (
    <span className="flex gap-[2px]">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="h-1.5 w-1.5 rounded-full bg-amber-400" />
      ))}
    </span>
  );
}

function Field({ tall = false }: { tall?: boolean }) {
  return <span className={`block w-full rounded-[3px] border border-zinc-300 bg-zinc-50 ${tall ? "h-3.5" : "h-2"}`} />;
}

/** Schematic of one block type. */
export function BlockThumb({ type }: { type: BlockType }) {
  switch (type) {
    case "announcement":
      return (
        <Frame>
          <span className="flex h-3 w-full items-center justify-center rounded-[3px] bg-indigo-500">{bar("60%", "bg-white/80")}</span>
        </Frame>
      );
    case "free_shipping_bar":
      return (
        <Frame>
          {bar("75%")}
          <span className="block h-1.5 w-full overflow-hidden rounded-full bg-zinc-200">
            <span className="block h-full w-2/3 rounded-full bg-indigo-500" />
          </span>
        </Frame>
      );
    case "countdown":
      return (
        <Frame>
          <span className="flex items-center justify-between rounded-[3px] bg-red-50 px-1 py-0.5 ring-1 ring-red-200">
            {bar("40%", "bg-red-300")}
            <span className="font-mono text-[6px] leading-none font-bold text-red-700">00:59</span>
          </span>
        </Frame>
      );
    case "low_stock":
      return (
        <Frame>
          {bar("60%", "bg-orange-400")}
          <span className="block h-1 w-full rounded-full bg-orange-100">
            <span className="block h-full w-1/4 rounded-full bg-orange-500" />
          </span>
        </Frame>
      );
    case "delivery_estimate":
      return (
        <Frame>
          {bar("55%")}
          <span className="flex items-center gap-0.5">
            <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
            <span className="h-px flex-1 bg-zinc-300" />
            <span className="h-1.5 w-1.5 rounded-full border border-zinc-400" />
            <span className="h-px flex-1 bg-zinc-300" />
            <span className="h-1.5 w-1.5 rounded-full border border-zinc-400" />
          </span>
        </Frame>
      );
    case "order_addons":
      return (
        <Frame>
          {[0, 1].map((i) => (
            <span key={i} className="flex items-center gap-1 rounded-[3px] border border-dashed border-zinc-300 px-0.5 py-[2px]">
              <span className={`h-1.5 w-1.5 rounded-[2px] ${i === 0 ? "bg-indigo-500" : "border border-zinc-400"}`} />
              {bar("55%")}
            </span>
          ))}
        </Frame>
      );
    case "order_note":
      return (
        <Frame>
          {bar("60%")}
          <Field tall />
        </Frame>
      );
    case "secure_badge":
    case "guarantee":
      return (
        <Frame>
          <span className="flex items-center gap-1">
            <span className="h-4 w-4 shrink-0 rounded-[4px] bg-emerald-200" />
            <span className="flex flex-1 flex-col gap-0.5">
              {bar("80%")}
              {bar("60%", "bg-zinc-200")}
            </span>
          </span>
        </Frame>
      );
    case "reviews":
    case "testimonial":
      return (
        <Frame>
          <StarsRow />
          {bar("90%", "bg-zinc-200")}
          {bar("65%", "bg-zinc-200")}
        </Frame>
      );
    case "rating":
      return (
        <Frame>
          <span className="flex items-center gap-1">
            <StarsRow />
            {bar("30%")}
          </span>
        </Frame>
      );
    case "trust_badges":
      return (
        <Frame>
          {[0, 1, 2].map((i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" />
              {bar(`${70 - i * 12}%`)}
            </span>
          ))}
        </Frame>
      );
    case "payment_icons":
      return (
        <Frame>
          <span className="flex justify-center gap-0.5">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="h-2.5 w-3 rounded-[2px] border border-zinc-300 bg-zinc-50" />
            ))}
          </span>
        </Frame>
      );
    case "comparison":
      return (
        <Frame>
          {[0, 1, 2].map((i) => (
            <span key={i} className="flex items-center gap-1">
              {bar("55%")}
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span className={`h-1.5 w-1.5 rounded-full ${i === 2 ? "bg-emerald-500" : "bg-zinc-300"}`} />
            </span>
          ))}
        </Frame>
      );
    case "stats":
      return (
        <Frame>
          <span className="flex justify-between">
            {[0, 1, 2].map((i) => (
              <span key={i} className="text-[8px] leading-none font-bold text-indigo-500">
                4,8
              </span>
            ))}
          </span>
          {bar("100%", "bg-zinc-200")}
        </Frame>
      );
    case "logos":
      return (
        <Frame>
          <span className="flex justify-between gap-1">
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-2 flex-1 rounded-[2px] bg-zinc-300" />
            ))}
          </span>
        </Frame>
      );
    case "benefits":
    case "value_props":
      return (
        <Frame>
          <Tiles round={type === "value_props"} />
        </Frame>
      );
    case "why_us":
      return (
        <Frame>
          {[0, 1].map((i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="h-2.5 w-2.5 shrink-0 rounded-[3px] bg-indigo-200" />
              {bar("70%")}
            </span>
          ))}
        </Frame>
      );
    case "faq":
      return (
        <Frame>
          {[0, 1].map((i) => (
            <span key={i} className="flex items-center justify-between rounded-[2px] border border-zinc-200 px-0.5 py-[2px]">
              {bar("60%")}
              <span className="text-[7px] leading-none text-zinc-400">+</span>
            </span>
          ))}
        </Frame>
      );
    case "text":
      return (
        <Frame>
          {bar("50%", "bg-zinc-500")}
          {bar("95%", "bg-zinc-200")}
          {bar("80%", "bg-zinc-200")}
        </Frame>
      );
    case "image":
    case "video":
      return (
        <Frame className="!p-1">
          <span className="relative flex h-full w-full items-center justify-center rounded-[4px] bg-gradient-to-br from-indigo-100 to-sky-100">
            {type === "video" ? (
              <span className="h-0 w-0 border-y-[4px] border-l-[6px] border-y-transparent border-l-indigo-500" />
            ) : (
              <span className="absolute right-1 bottom-1 left-1 h-2 [clip-path:polygon(0_100%,35%_20%,60%_70%,75%_45%,100%_100%)] bg-indigo-300" />
            )}
          </span>
        </Frame>
      );
    case "support":
      return (
        <Frame>
          {bar("55%", "bg-zinc-500")}
          <span className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-2 flex-1 rounded-full border border-zinc-300" />
            ))}
          </span>
        </Frame>
      );
    case "spacer":
      return (
        <Frame>
          <span className="block h-px w-full border-t border-dashed border-zinc-400" />
        </Frame>
      );
    case "button_link":
      return (
        <Frame>
          <span className="flex h-3 w-full items-center justify-center rounded-full bg-indigo-500">{bar("45%", "bg-white/80")}</span>
        </Frame>
      );
    case "shipping_protection":
      return (
        <Frame>
          <span className="flex items-center gap-1 rounded-[3px] border border-indigo-400 bg-indigo-50 px-0.5 py-[2px]">
            <span className="h-1.5 w-1.5 rounded-[2px] bg-indigo-500" />
            {bar("55%", "bg-indigo-300")}
          </span>
        </Frame>
      );
    case "survey":
      return (
        <Frame>
          {bar("65%")}
          <span className="flex flex-wrap gap-[2px]">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="h-2 w-3 rounded-full border border-zinc-300 bg-white" />
            ))}
          </span>
        </Frame>
      );
    case "coupon":
      return (
        <Frame>
          {bar("60%")}
          <span className="flex h-3 w-full items-center justify-center rounded-[3px] border border-dashed border-indigo-400 bg-indigo-50">
            <span className="font-mono text-[6px] leading-none font-bold text-indigo-600">CODE</span>
          </span>
        </Frame>
      );
    case "recommendations":
      return (
        <Frame>
          {[0, 1].map((i) => (
            <span key={i} className="flex items-center gap-1 rounded-[3px] border border-zinc-200 px-0.5 py-[2px]">
              <span className="h-2.5 w-2.5 shrink-0 rounded-[2px] bg-zinc-200" />
              <span className="flex flex-1 flex-col gap-[2px]">{bar("80%")}</span>
              <span className="h-2 w-3.5 shrink-0 rounded-[2px] bg-indigo-500" />
            </span>
          ))}
        </Frame>
      );
    case "upsell":
      return (
        <Frame>
          <span className="flex items-center gap-1">
            <span className="h-3.5 w-3.5 shrink-0 rounded-[3px] bg-zinc-200" />
            <span className="flex flex-1 flex-col gap-0.5">
              {bar("80%")}
              {bar("50%", "bg-zinc-200")}
            </span>
          </span>
          <span className="block h-2 w-full rounded-full bg-indigo-500" />
        </Frame>
      );
    case "social":
      return (
        <Frame>
          <span className="flex justify-center gap-1">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="h-2.5 w-2.5 rounded-full bg-zinc-300" />
            ))}
          </span>
        </Frame>
      );
    default:
      return (
        <Frame>
          {bar("60%", "bg-zinc-400")}
          <Field />
        </Frame>
      );
  }
}

const line = (w: string, cls = "bg-zinc-300") => <span className={`block h-[2px] rounded-full ${cls}`} style={{ width: w }} />;

/** One block of a template thumbnail: a recognisable silhouette per type (fixed sections stay grey). */
function Mini({ type }: { type: BlockType }) {
  switch (type) {
    case "announcement":
      return <span className="flex h-2 w-full items-center justify-center rounded-[2px] bg-indigo-500">{line("55%", "bg-white/80")}</span>;
    case "countdown":
      return (
        <span className="flex h-2.5 w-full items-center justify-between rounded-[2px] bg-red-50 px-[3px] ring-1 ring-red-200">
          {line("40%", "bg-red-300")}
          <span className="flex gap-[1px]">
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-1.5 w-1 rounded-[1px] bg-red-500" />
            ))}
          </span>
        </span>
      );
    case "free_shipping_bar":
      return (
        <span className="flex flex-col gap-[2px]">
          {line("60%")}
          <span className="block h-[3px] w-full rounded-full bg-zinc-200">
            <span className="block h-full w-2/3 rounded-full bg-indigo-500" />
          </span>
        </span>
      );
    case "express":
      return (
        <span className="flex gap-[2px]">
          <span className="h-2 flex-1 rounded-[2px] bg-zinc-900" />
          <span className="h-2 flex-1 rounded-[2px] bg-zinc-500" />
        </span>
      );
    case "contact":
      return <span className="block h-2 w-full rounded-[2px] border border-zinc-300 bg-white" />;
    case "delivery":
      return (
        <span className="grid grid-cols-2 gap-[2px]">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`h-1.5 rounded-[1px] border border-zinc-300 bg-white ${i === 2 ? "col-span-2" : ""}`} />
          ))}
        </span>
      );
    case "shipping_method":
      return (
        <span className="flex flex-col gap-[1px] rounded-[2px] border border-zinc-300 bg-white p-[2px]">
          {[0, 1].map((i) => (
            <span key={i} className="flex items-center gap-[2px]">
              <span className={`h-1 w-1 rounded-full ${i === 0 ? "bg-zinc-600" : "border border-zinc-400"}`} />
              {line("50%")}
            </span>
          ))}
        </span>
      );
    case "payment":
      return (
        <span className="flex flex-col gap-[2px]">
          <span className="block h-2 w-full rounded-[2px] border border-zinc-300 bg-white" />
          <span className="block h-2.5 w-full rounded-[var(--thumb-btn-radius,2px)] bg-[image:var(--thumb-accent,linear-gradient(#27272a,#27272a))]" />
        </span>
      );
    case "order_addons":
      return (
        <span className="flex items-center gap-[2px] rounded-[2px] border border-dashed border-indigo-400 bg-indigo-50 p-[2px]">
          <span className="h-1.5 w-1.5 rounded-[1px] border border-indigo-500 bg-white" />
          {line("55%", "bg-indigo-300")}
        </span>
      );
    case "secure_badge":
      return (
        <span className="flex items-center gap-[2px] rounded-[2px] bg-emerald-50 p-[2px] ring-1 ring-emerald-200">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          {line("60%", "bg-emerald-300")}
        </span>
      );
    case "payment_icons":
      return (
        <span className="flex gap-[2px]">
          {["bg-blue-500", "bg-orange-400", "bg-zinc-800", "bg-sky-400"].map((c) => (
            <span key={c} className={`h-1.5 flex-1 rounded-[1px] ${c}`} />
          ))}
        </span>
      );
    case "reviews":
    case "rating":
    case "testimonial":
      return (
        <span className="flex flex-col gap-[2px] rounded-[2px] bg-white p-[2px] ring-1 ring-zinc-200">
          <span className="flex gap-[1px]">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className="h-1 w-1 rounded-full bg-amber-400" />
            ))}
          </span>
          {line("85%")}
        </span>
      );
    case "guarantee":
    case "trust_badges":
      return (
        <span className="flex items-center gap-[2px]">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
          {line("55%")}
        </span>
      );
    case "benefits":
    case "value_props":
    case "why_us":
      return (
        <span className="flex gap-[2px]">
          {[0, 1, 2].map((i) => (
            <span key={i} className="flex flex-1 flex-col items-center gap-[1px]">
              <span className="h-1.5 w-1.5 rounded-[1px] bg-indigo-300" />
              {line("80%")}
            </span>
          ))}
        </span>
      );
    case "ty_confirmation":
      return (
        <span className="flex items-center gap-[3px]">
          <span className="h-3 w-3 shrink-0 rounded-full bg-zinc-800" />
          <span className="flex flex-1 flex-col gap-[2px]">
            {line("70%", "bg-zinc-400")}
            {line("45%")}
          </span>
        </span>
      );
    case "ty_details":
      return (
        <span className="grid grid-cols-2 gap-[3px] rounded-[2px] border border-zinc-200 bg-white p-[2px]">
          <span className="flex flex-col gap-[1px]">
            {line("80%")}
            {line("60%")}
          </span>
          <span className="flex flex-col gap-[1px]">
            {line("70%")}
            {line("50%")}
          </span>
        </span>
      );
    case "ty_summary":
      return (
        <span className="flex flex-col gap-[2px] rounded-[2px] border border-zinc-200 bg-white p-[2px]">
          <span className="flex items-center gap-[2px]">
            <span className="h-1.5 w-1.5 rounded-[1px] bg-zinc-300" />
            {line("50%")}
          </span>
          {line("100%", "bg-zinc-400")}
        </span>
      );
    case "upsell":
      return (
        <span className="flex flex-col gap-[2px] rounded-[2px] border-2 border-indigo-500 bg-white p-[2px]">
          <span className="flex items-center gap-[2px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[1px] bg-indigo-200" />
            <span className="flex flex-1 flex-col gap-[1px]">
              {line("80%", "bg-zinc-400")}
              {line("50%")}
            </span>
          </span>
          <span className="block h-1.5 w-full rounded-[1px] bg-indigo-500" />
        </span>
      );
    case "recommendations":
      return (
        <span className="flex flex-col gap-[2px]">
          {[0, 1].map((i) => (
            <span key={i} className="flex items-center gap-[2px] rounded-[2px] bg-white p-[2px] ring-1 ring-zinc-200">
              <span className="h-1.5 w-1.5 shrink-0 rounded-[1px] bg-zinc-300" />
              {line("45%")}
              <span className="ml-auto h-1.5 w-2 rounded-[1px] bg-indigo-500" />
            </span>
          ))}
        </span>
      );
    case "shipping_protection":
      return (
        <span className="flex items-center gap-[2px] rounded-[2px] border border-indigo-400 bg-indigo-50 p-[2px]">
          <span className="h-1.5 w-1.5 rounded-[1px] bg-indigo-500" />
          {line("55%", "bg-indigo-300")}
        </span>
      );
    case "survey":
      return (
        <span className="flex flex-wrap justify-center gap-[2px]">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-1.5 w-2.5 rounded-full border border-zinc-400 bg-white" />
          ))}
        </span>
      );
    case "coupon":
      return (
        <span className="flex h-3.5 items-center justify-center rounded-[2px] border border-dashed border-amber-500 bg-amber-50">
          <span className="h-1.5 w-1/2 rounded-[1px] bg-amber-400" />
        </span>
      );
    case "social":
      return (
        <span className="flex justify-center gap-[3px]">
          {["bg-pink-400", "bg-zinc-800", "bg-blue-500", "bg-red-500"].map((c) => (
            <span key={c} className={`h-2 w-2 rounded-full ${c}`} />
          ))}
        </span>
      );
    case "button_link":
      return <span className="block h-2.5 w-full rounded-[2px] border border-zinc-700 bg-white" />;
    case "support":
      return (
        <span className="flex items-center gap-[2px]">
          <span className="h-2 w-2 rounded-full bg-sky-400" />
          {line("60%")}
        </span>
      );
    case "delivery_estimate":
      return (
        <span className="flex items-center">
          {[0, 1, 2].map((i) => (
            <span key={i} className="flex flex-1 items-center">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${i === 0 ? "bg-indigo-500" : "border border-indigo-300 bg-white"}`} />
              {i < 2 && <span className="h-[1px] flex-1 bg-indigo-200" />}
            </span>
          ))}
        </span>
      );
    case "text":
      return (
        <span className="flex flex-col gap-[2px]">
          {line("65%", "bg-zinc-500")}
          {line("90%")}
        </span>
      );
    default:
      return <span className="block h-1.5 w-full rounded-[1px] bg-indigo-300" />;
  }
}

/** Colors and shapes of a styled template, painted on its thumbnail. */
export type ThumbLook = {
  headerBackground: string;
  pageBackground: string;
  formBackground: string;
  summaryBackground: string;
  accentColor: string;
  accentColor2: string;
  buttonShape: "default" | "pill" | "square";
  radius: number;
};

/**
 * Schematic of a whole template: each block drawn with its own silhouette (banner,
 * reviews, offer card…), with the summary column on checkout. With a look, the header,
 * backgrounds and pay button take the template's colors.
 */
export function TemplateThumb({ spec, page, look }: { spec: Spec[]; page: "checkout" | "thank-you"; look?: ThumbLook }) {
  // Checkout: the columns as the page draws them (reassurance widgets in the summary column,
  // content blocks under the payment), not the list order.
  const { form, summary: side } =
    page === "checkout" ? renderedColumns(spec) : { form: spec.map(([type]) => type), summary: [] as BlockType[] };
  const vars = look
    ? ({
        "--thumb-accent": `linear-gradient(90deg, ${look.accentColor}, ${look.accentColor2 || look.accentColor})`,
        "--thumb-btn-radius": look.buttonShape === "pill" ? "999px" : look.buttonShape === "square" ? "0px" : `${Math.min(look.radius / 4, 3)}px`,
        background: look.pageBackground || "#ffffff",
      } as CSSProperties)
    : undefined;
  return (
    <span aria-hidden style={vars} className="flex h-[92px] w-[104px] shrink-0 flex-col overflow-hidden rounded-lg bg-zinc-50 ring-1 ring-zinc-200">
      {look && <span className="block h-2 w-full shrink-0 border-b border-black/10" style={{ background: look.headerBackground }} />}
      <span className="flex min-h-0 flex-1 gap-1 p-1.5">
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]" style={look?.formBackground ? { background: look.formBackground } : undefined}>
          {form.map((type, i) => (
            <Mini key={i} type={type} />
          ))}
        </span>
        {page === "checkout" && (
          <span
            className="flex w-[36%] flex-col gap-[3px] rounded-[3px] bg-zinc-200/70 p-[3px]"
            style={look ? { background: look.summaryBackground || look.pageBackground || "#ffffff", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.06)" } : undefined}
          >
            <span className="flex flex-col gap-[2px] rounded-[2px] bg-white p-[2px]">
              {line("80%")}
              {line("60%")}
            </span>
            {side.map((type, i) => (
              <Mini key={i} type={type} />
            ))}
          </span>
        )}
      </span>
    </span>
  );
}
