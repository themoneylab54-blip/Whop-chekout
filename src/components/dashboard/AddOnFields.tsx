"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Input, Label } from "@/components/ui";
import { ProductPicker, type PickedVariant } from "./ProductPicker";
import { Thumb } from "./Thumb";
import { MoneyInput } from "./MoneyInput";
import { RecordTranslationsEditor } from "./RecordTranslations";
import type { Lang } from "@/components/checkout/i18n";

/** Sets a field from code and lets the form know (dirty tracking listens to `input`). */
function fill(el: HTMLInputElement | null, value: string) {
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export type AddOnValues = { title: string; description: string | null; price: string; variantId: string | null; imageUrl: string | null; cost?: string; i18n?: unknown };

/**
 * Order bump fields: title, description, price, the Shopify product it adds (searchable picker)
 * and its image (URL, or one of the chosen product's images in one click). Picking a product
 * fills the title, price and image when they are still empty.
 */
export function AddOnFields({ prefix, storeId, currency, a, baseLang = "fr" }: { prefix: string; storeId: string; currency: string; a?: AddOnValues; baseLang?: Lang }) {
  const id = (k: string) => `${prefix}-${k}`;
  const title = useRef<HTMLInputElement>(null);
  const price = useRef<HTMLInputElement>(null);
  const image = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<PickedVariant | null>(null);
  const [imageUrl, setImageUrl] = useState(a?.imageUrl ?? "");

  // "Annuler" resets the uncontrolled fields: mirror the image field again.
  useEffect(() => {
    const form = image.current?.form;
    if (!form) return;
    const onReset = () => setTimeout(() => setImageUrl(image.current?.value ?? ""), 0);
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, []);

  function onPick(p: PickedVariant | null, userAction: boolean) {
    setPicked(p);
    if (!userAction || !p?.product || !p.variant) return;
    const { product, variant } = p;
    if (title.current && !title.current.value.trim()) fill(title.current, variant.title !== "Default Title" ? `${product.title} — ${variant.title}` : product.title);
    if (price.current && !price.current.value.trim()) fill(price.current, Number(variant.price).toFixed(2).replace(".", ","));
    const img = variant.imageUrl ?? product.imageUrl;
    if (img && image.current && !image.current.value.trim()) {
      fill(image.current, img);
      setImageUrl(img);
    }
  }

  // The lookup of an already saved variant reports through onPick too, without filling anything.
  const userPick = useRef(false);
  const images = picked?.product?.images ?? [];

  return (
    <>
      <div className="sm:col-span-2">
        <Label htmlFor={id("variantId")} hint="Facultatif : ajoute ce produit à la commande Shopify. Recherchez-le, ou collez l'ID de la variante.">
          Produit Shopify
        </Label>
        <div
          onPointerDownCapture={() => (userPick.current = true)}
          onKeyDownCapture={() => (userPick.current = true)}
        >
          <ProductPicker
            storeId={storeId}
            name="variantId"
            inputId={id("variantId")}
            currency={currency}
            defaultValue={a?.variantId}
            onPick={(p) => {
              onPick(p, userPick.current);
              userPick.current = false;
            }}
          />
        </div>
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor={id("title")}>Titre</Label>
        <Input ref={title} id={id("title")} name="title" defaultValue={a?.title} placeholder="Livraison prioritaire" required maxLength={80} />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor={id("description")} hint="Facultatif">
          Description
        </Label>
        <Input id={id("description")} name="description" defaultValue={a?.description ?? ""} placeholder="Expédiée en premier, sous 24 h" maxLength={200} />
      </div>
      <div>
        <Label htmlFor={id("price")} hint={`Prix de l'option au checkout (${currency})`}>
          Prix
        </Label>
        <MoneyInput ref={price} id={id("price")} name="price" currency={currency} placeholder="2,99" required defaultValue={a?.price} />
      </div>
      <div>
        <Label htmlFor={id("cost")} hint="Facultatif · ce que l'option vous coûte, pour la marge. Vide : le coût saisi dans Coûts produits pour ce produit Shopify">
          Coût du produit
        </Label>
        <MoneyInput id={id("cost")} name="cost" currency={currency} placeholder="ex. 1,20" defaultValue={a?.cost ?? ""} />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor={id("imageUrl")} hint={images.length ? "Facultatif · choisissez une image du produit ou collez une URL" : "Facultatif · URL d'une image"}>
          Image
        </Label>
        <div className="flex items-center gap-2">
          <Thumb src={imageUrl || null} size={38} />
          <Input
            ref={image}
            id={id("imageUrl")}
            name="imageUrl"
            type="url"
            placeholder="https://…"
            defaultValue={a?.imageUrl ?? ""}
            onInput={(e) => setImageUrl(e.currentTarget.value)}
            className="min-w-0"
          />
        </div>
        {images.length > 0 && (
          <div role="group" aria-label="Images du produit" className="mt-2 flex flex-wrap gap-2">
            {images.map((src, i) => {
              const selected = src === imageUrl;
              return (
                <button
                  key={src}
                  type="button"
                  aria-pressed={selected}
                  aria-label={`Utiliser l'image ${i + 1} du produit`}
                  onClick={() => {
                    fill(image.current, src);
                    setImageUrl(src);
                  }}
                  className={`relative rounded-lg transition ${selected ? "ring-2 ring-indigo-500 ring-offset-1" : "opacity-90 hover:opacity-100"}`}
                >
                  <Thumb src={src} size={44} />
                  {selected && (
                    <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-indigo-600 text-white" aria-hidden>
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="sm:col-span-2">
        <RecordTranslationsEditor
          fields={[
            { key: "title", label: "Titre", base: a?.title ?? "" },
            { key: "description", label: "Description", base: a?.description ?? "", long: true },
          ]}
          initial={a?.i18n}
          baseLang={baseLang}
        />
      </div>
    </>
  );
}
