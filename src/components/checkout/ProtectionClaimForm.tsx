"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, ImagePlus, X } from "lucide-react";
import type { Labels } from "./i18n";

/**
 * "Signaler un problème de livraison" on the order status page (shipping protection bought,
 * within 30 days): reason, description and up to 3 photos. Every photo is re-encoded in the browser
 * as a JPEG of at most 1.2 MB (4 MB in all), so the request stays under the hosting's 4.5 MB body
 * limit; a photo the browser can't decode (HEIC on most desktop browsers) gets a clear message. The
 * server checks the size and the image type again. Creates a pending claim the merchant accepts or
 * refuses on the order page.
 */

export const MAX_PHOTOS = 3;
/** Each photo after re-encoding. */
export const MAX_PHOTO_UPLOAD_BYTES = 1_200_000;
/** All photos of one report (the server refuses a request over 4.4 MB). */
export const MAX_PHOTOS_TOTAL_BYTES = 4_000_000;

/** A HEIC / HEIF photo (iPhone), by type or name. Pure. */
export function isHeic(f: { name: string; type: string }): boolean {
  return /^image\/hei[cf]/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);
}

/** Longest edge and JPEG quality tried in turn until the photo fits. */
const ENCODE_STEPS: [number, number][] = [
  [2000, 0.85],
  [2000, 0.72],
  [1600, 0.7],
  [1280, 0.65],
  [1024, 0.6],
  [800, 0.55],
];

/**
 * First encoding (smaller edge / quality each step) of at most `maxBytes`, or null. `encode` draws
 * the image at a size and returns the JPEG. Pure apart from `encode`, exported for tests.
 */
export async function encodeUnder(
  maxBytes: number,
  width: number,
  height: number,
  encode: (w: number, h: number, quality: number) => Promise<{ size: number } | null>,
): Promise<{ size: number } | null> {
  for (const [edge, quality] of ENCODE_STEPS) {
    const scale = Math.min(1, edge / Math.max(width, height, 1));
    const out = await encode(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), quality);
    if (out && out.size <= maxBytes) return out;
  }
  return null;
}

/** Why the photos can't be sent ("heic" / "type": undecodable, "size": too large even compressed), or null. Pure. */
export function photosProblem(results: (File | "heic" | "type" | "size")[]): "heic" | "type" | "size" | null {
  for (const r of results) if (typeof r === "string") return r;
  const total = (results as File[]).reduce((n, f) => n + f.size, 0);
  return total > MAX_PHOTOS_TOTAL_BYTES ? "size" : null;
}

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void };

/** The photo decoded by the browser (ImageBitmap, else an <img>), or null when it can't read it. */
async function decode(file: File): Promise<Decoded | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const b = await createImageBitmap(file);
      return { source: b, width: b.width, height: b.height, close: () => b.close() };
    } catch {
      /* try the <img> route (older Safari) */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img.naturalWidth ? { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) } : null;
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

/** A photo re-encoded as a JPEG of at most MAX_PHOTO_UPLOAD_BYTES, or why it can't be. */
async function toJpeg(file: File): Promise<File | "heic" | "type" | "size"> {
  const img = await decode(file);
  if (!img) return isHeic(file) ? "heic" : "type";
  try {
    const canvas = document.createElement("canvas");
    const g = canvas.getContext("2d");
    if (!g) return "type";
    const blob = (await encodeUnder(MAX_PHOTO_UPLOAD_BYTES, img.width, img.height, async (w, h, quality) => {
      canvas.width = w;
      canvas.height = h;
      // JPEG has no transparency: a white background instead of black.
      g.fillStyle = "#fff";
      g.fillRect(0, 0, w, h);
      g.drawImage(img.source, 0, 0, w, h);
      return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    })) as Blob | null;
    return blob ? new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "photo"}.jpg`, { type: "image/jpeg" }) : "size";
  } finally {
    img.close();
  }
}
/** "c••••@example.fr": enough for the buyer to recognise the order's e-mail. Pure. */
export function maskEmail(email: string): string {
  const [local, domain] = email.trim().split("@");
  if (!local || !domain) return "";
  return `${local[0]}••••@${domain}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An image file the picker accepts (any image/*, or a HEIC by name when the type is empty). Pure. */
export function isImageFile(f: { name: string; type: string }): boolean {
  return /^image\//.test(f.type) || isHeic(f);
}

type Picked = { id: number; file: File; /** Object URL for the thumbnail (null: HEIC, not previewable). */ url: string | null };
type FieldErrors = { email?: string; photos?: string };

export function ProtectionClaimForm({
  sessionId,
  L,
  status,
  orderEmail,
  photos,
}: {
  sessionId: string;
  L: Labels;
  status: "pending" | "approved" | "rejected" | null;
  /** The order's e-mail (buyer's own order page): shown masked as a hint and checked before sending. */
  orderEmail?: string;
  /** Photos of the latest report (signed links), shown with its status. */
  photos?: string[];
}) {
  const uid = useId().replace(/:/g, "");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent">(status === "pending" ? "sent" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [alreadyPending, setAlreadyPending] = useState(false);
  // Photos picked so far (thumbnails, one "remove" each), added one selection at a time.
  const [picked, setPicked] = useState<Picked[]>([]);
  const pickSeq = useRef(0);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const pickedRef = useRef<Picked[]>([]);
  useEffect(() => {
    pickedRef.current = picked;
  }, [picked]);
  // Object URLs are released on unmount.
  useEffect(() => () => pickedRef.current.forEach((p) => p.url && URL.revokeObjectURL(p.url)), []);
  // Focus follows the buyer's action (WCAG 2.4.3): first field on open, the result once sent,
  // the "report" button again on cancel. Not on first render (the page doesn't jump).
  const moveFocus = useRef<"form" | "status" | "cta" | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const ctaRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const target = moveFocus.current;
    moveFocus.current = null;
    if (target === "form") firstFieldRef.current?.focus();
    else if (target === "status") statusRef.current?.focus();
    else if (target === "cta") ctaRef.current?.focus();
  }, [open, state]);
  const masked = orderEmail ? maskEmail(orderEmail) : "";
  const reasons: [string, string][] = [
    ["lost", L.claimLost],
    ["stolen", L.claimStolen],
    ["damaged", L.claimDamaged],
    ["wrong", L.claimWrong],
    ["other", L.claimOther],
  ];

  if (state === "sent" || status === "approved" || status === "rejected") {
    const text = alreadyPending
      ? L.claimAlreadyPending
      : status === "approved" ? L.claimApproved : status === "rejected" ? L.claimRejected : state === "sent" && status !== "pending" ? L.claimSent : L.claimPending;
    return (
      <>
        <p ref={statusRef} tabIndex={-1} role="status" className="mt-2 rounded-sm text-sm font-medium text-emerald-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">
          {text}
        </p>
        {!!photos?.length && (
          <ul className="mt-2 flex flex-wrap gap-2" aria-label={L.claimPhotos}>
            {photos.map((src, i) => (
              <li key={src}>
                <a href={src} target="_blank" rel="noopener noreferrer" className="block rounded-md ring-1 ring-emerald-900/20">
                  {/* eslint-disable-next-line @next/next/no-img-element -- signed private link */}
                  <img src={src} alt={`${L.claimPhotos} ${i + 1}`} className="h-14 w-14 rounded-md object-cover" loading="lazy" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  /** Inline errors (localized), or none. The server checks again. */
  function validate(fd: FormData): FieldErrors {
    const errs: FieldErrors = {};
    const email = String(fd.get("email") ?? "").trim();
    if (!email) errs.email = L.claimEmailRequired;
    else if (!EMAIL_RE.test(email)) errs.email = L.claimEmailInvalid;
    else if (orderEmail && email.toLowerCase() !== orderEmail.trim().toLowerCase()) errs.email = L.claimEmailMismatch;
    const files = picked.map((p) => p.file);
    if (files.length > MAX_PHOTOS) errs.photos = L.claimPhotosTooMany;
    else if (files.some((f) => !isImageFile(f))) errs.photos = L.claimPhotoType;
    return errs;
  }

  function focusFirstInvalid(form: HTMLFormElement, errs: FieldErrors) {
    if (errs.email) (form.elements.namedItem("email") as HTMLElement | null)?.focus();
    else if (errs.photos) photoInputRef.current?.focus();
  }

  /** Adds the chosen files (images only, up to MAX_PHOTOS), with an immediate message otherwise. */
  function addPhotos(list: FileList | null) {
    const chosen = Array.from(list ?? []).filter((f) => f.size > 0);
    if (!chosen.length) return;
    const images = chosen.filter(isImageFile);
    const room = MAX_PHOTOS - picked.length;
    const kept = images.slice(0, Math.max(0, room));
    const problem = images.length < chosen.length ? L.claimPhotoType : images.length > room ? L.claimPhotosTooMany : undefined;
    if (kept.length) {
      setPicked((prev) => [
        ...prev,
        ...kept.map((file) => ({ id: ++pickSeq.current, file, url: isHeic(file) && !/^image\/(jpeg|png|webp|gif)/.test(file.type) ? null : URL.createObjectURL(file) })),
      ]);
    }
    setFieldErrors((f) => ({ ...f, photos: problem }));
  }

  function removePhoto(id: number, index: number) {
    setPicked((prev) => {
      const gone = prev.find((p) => p.id === id);
      if (gone?.url) URL.revokeObjectURL(gone.url);
      return prev.filter((p) => p.id !== id);
    });
    setFieldErrors((f) => ({ ...f, photos: undefined }));
    // Focus stays in the list: the next remove button, else the "add" control.
    requestAnimationFrame(() => {
      const buttons = photoInputRef.current?.form?.querySelectorAll<HTMLButtonElement>(`ul[aria-labelledby="${uid}-photos-label"] button`);
      const next = buttons?.[Math.min(index, (buttons?.length ?? 1) - 1)];
      (next ?? photoInputRef.current)?.focus();
    });
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const errs = validate(fd);
    setFieldErrors(errs);
    setError(null);
    if (errs.email || errs.photos) return focusFirstInvalid(form, errs);
    setState("sending");
    try {
      // Photos: always re-encoded to JPEG (1.2 MB each, 4 MB in all); the server checks again.
      const prepared = await Promise.all(picked.map((p) => toJpeg(p.file)));
      const problem = photosProblem(prepared);
      if (problem) {
        setState("idle");
        const fe = { photos: problem === "heic" ? L.claimPhotoHeic : problem === "size" ? L.claimPhotoTooBig : L.claimPhotoType };
        setFieldErrors(fe);
        return focusFirstInvalid(form, fe);
      }
      const files = prepared as File[];
      const body = new FormData();
      for (const k of ["email", "reason", "details"]) body.set(k, String(fd.get(k) ?? ""));
      for (const f of files) body.append("photos", f, f.name);
      const res = await fetch(`/api/public/sessions/${sessionId}/claim`, { method: "POST", body });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        setState("idle");
        // 413: our JSON answer, or the host's own page when the body was refused before reaching us.
        if (res.status === 413) body.code = "photo_size";
        if (body.code === "photo_size" || body.code === "photo_type" || body.code === "photo_count") {
          const fe = { photos: body.code === "photo_size" ? L.claimPhotoTooBig : body.code === "photo_count" ? L.claimPhotosTooMany : L.claimPhotoType };
          setFieldErrors(fe);
          return focusFirstInvalid(form, fe);
        }
        if (body.code === "email") {
          const fe = { email: L.claimEmailMismatch };
          setFieldErrors(fe);
          return focusFirstInvalid(form, fe);
        }
        if (body.code === "pending") {
          moveFocus.current = "status";
          setAlreadyPending(true);
          return setState("sent");
        }
        return setError(L.claimError);
      }
      moveFocus.current = "status";
      setState("sent");
    } catch {
      setState("idle");
      setError(L.claimError);
    }
  }

  if (!open) {
    return (
      <button
        ref={ctaRef}
        type="button"
        onClick={() => {
          moveFocus.current = "form";
          setOpen(true);
        }}
        className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-sm text-left text-sm font-medium text-emerald-900 underline underline-offset-2 hover:no-underline"
      >
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
        {L.claimCta}
      </button>
    );
  }

  const field = "w-full rounded-[var(--radius)] border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900";
  return (
    <form onSubmit={submit} noValidate className="mt-3 space-y-3" aria-labelledby={`${uid}-title`}>
      <p id={`${uid}-title`} className="font-semibold">
        {L.claimCta}
      </p>
      <div>
        <label htmlFor={`${uid}-email`} className="mb-1 block text-xs font-medium text-neutral-800">
          {L.claimEmail}
        </label>
        <input
          ref={firstFieldRef}
          id={`${uid}-email`}
          name="email"
          type="email"
          required
          aria-required
          autoComplete="email"
          placeholder={masked || undefined}
          aria-invalid={!!fieldErrors.email || undefined}
          aria-describedby={[fieldErrors.email ? `${uid}-email-err` : "", masked ? `${uid}-email-hint` : ""].filter(Boolean).join(" ") || undefined}
          onChange={() => fieldErrors.email && setFieldErrors((f) => ({ ...f, email: undefined }))}
          className={`${field} ${fieldErrors.email ? "!border-red-700" : ""}`}
        />
        {masked && (
          <p id={`${uid}-email-hint`} className="mt-1 text-xs text-emerald-900">
            {L.claimEmailHint(masked)}
          </p>
        )}
        {fieldErrors.email && (
          <p id={`${uid}-email-err`} className="mt-1 text-xs font-medium text-red-700">
            {fieldErrors.email}
          </p>
        )}
      </div>
      <div>
        <label htmlFor={`${uid}-reason`} className="mb-1 block text-xs font-medium text-neutral-800">
          {L.claimReason}
        </label>
        <select id={`${uid}-reason`} name="reason" required className={field} defaultValue="lost">
          {reasons.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${uid}-details`} className="mb-1 block text-xs font-medium text-neutral-800">
          {L.claimDetails}
        </label>
        <textarea id={`${uid}-details`} name="details" rows={3} maxLength={1000} className={field} />
      </div>
      <div>
        <p id={`${uid}-photos-label`} className="mb-1 block text-xs font-medium text-neutral-800">
          {L.claimPhotos}
        </p>
        {picked.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-2" aria-labelledby={`${uid}-photos-label`}>
            {picked.map((p, i) => (
              <li key={p.id} className="relative">
                {p.url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- local preview (object URL)
                  <img src={p.url} alt={L.claimPhotoPreview(i + 1)} className="h-16 w-16 rounded-md object-cover ring-1 ring-neutral-900/10" />
                ) : (
                  <span role="img" aria-label={L.claimPhotoPreview(i + 1)} className="flex h-16 w-16 items-center justify-center rounded-md bg-neutral-100 px-1 text-center text-[10px] leading-tight break-all text-neutral-700 ring-1 ring-neutral-900/10">
                    {p.file.name.slice(-18)}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removePhoto(p.id, i)}
                  aria-label={L.claimPhotoRemove(i + 1)}
                  className="absolute -top-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full bg-neutral-900 text-white shadow ring-2 ring-white after:absolute after:-inset-2 after:content-[''] hover:bg-neutral-700"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={photoInputRef}
            id={`${uid}-photos`}
            type="file"
            multiple
            accept="image/*,.heic,.heif"
            disabled={picked.length >= MAX_PHOTOS}
            aria-invalid={!!fieldErrors.photos || undefined}
            aria-describedby={[`${uid}-photos-count`, `${uid}-photos-hint`, fieldErrors.photos ? `${uid}-photos-err` : ""].filter(Boolean).join(" ")}
            onChange={(e) => {
              addPhotos(e.currentTarget.files);
              e.currentTarget.value = "";
            }}
            className="peer sr-only"
          />
          <label
            htmlFor={`${uid}-photos`}
            className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-[var(--radius)] border border-dashed px-3 text-sm font-medium peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-700 peer-focus-visible:ring-offset-1 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 ${
              fieldErrors.photos ? "border-red-700 text-red-800" : "border-emerald-800/40 bg-white text-emerald-900 hover:bg-emerald-50"
            }`}
          >
            <ImagePlus className="h-4 w-4 shrink-0" aria-hidden />
            {picked.length ? L.claimPhotosAddMore : L.claimPhotosAdd}
          </label>
          <span id={`${uid}-photos-count`} aria-live="polite" className="text-xs text-neutral-700 tabular-nums">
            {L.claimPhotosCount(picked.length, MAX_PHOTOS)}
          </span>
        </div>
        <p id={`${uid}-photos-hint`} className="mt-1 text-xs text-neutral-700">
          {L.claimPhotosHint}
        </p>
        {fieldErrors.photos && (
          <p id={`${uid}-photos-err`} className="mt-1 text-xs font-medium text-red-700">
            {fieldErrors.photos}
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={state === "sending"}
          aria-busy={state === "sending"}
          className="inline-flex min-h-11 items-center rounded-[var(--btn-radius)] bg-emerald-800 px-4 text-sm font-semibold text-white disabled:opacity-60"
        >
          {L.claimSubmit}
        </button>
        <button
          type="button"
          onClick={() => {
            moveFocus.current = "cta";
            setFieldErrors({});
            setError(null);
            setOpen(false);
          }}
          className="inline-flex min-h-11 items-center px-2 text-sm text-emerald-900 underline underline-offset-2">
          {L.claimCancel}
        </button>
      </div>
    </form>
  );
}
