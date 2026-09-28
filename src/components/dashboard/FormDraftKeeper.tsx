"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  DRAFT_STORAGE_KEY,
  draftFields,
  draftForError,
  flashError,
  formSignature,
  freshDrafts,
  inlineMessage,
  mergeDrafts,
  parseDrafts,
  restorePlan,
  type ControlInfo,
  type FormDraft,
} from "./formDraft";

/*
 * DOM side of formDraft.ts: keeps what was typed in a dashboard form when its server action
 * redirects back with an error, and flags the field at fault. Mounted once in the store layout.
 */

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const DISCLOSURE_ATTR = "data-create-disclosure";
const LABEL_ATTR = "data-form-label";
const INVALID_ATTR = "data-draft-invalid";
const MESSAGE_ATTR = "data-field-error";

function readDrafts(): FormDraft[] {
  try {
    return parseDrafts(sessionStorage.getItem(DRAFT_STORAGE_KEY));
  } catch {
    return [];
  }
}

function writeDrafts(drafts: FormDraft[]) {
  try {
    if (drafts.length) sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts));
    else sessionStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    /* private mode, quota: the form simply isn't restored */
  }
}

function controls(form: HTMLFormElement): Control[] {
  return Array.from(form.elements).filter(
    (el): el is Control => el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement,
  );
}

function info(el: Control): ControlInfo {
  const type = el instanceof HTMLInputElement ? el.type : el instanceof HTMLSelectElement ? "select" : "textarea";
  return {
    name: el.name,
    type,
    value: el.value,
    checked: el instanceof HTMLInputElement ? el.checked : undefined,
    noDraft: el.disabled || el.closest("[data-no-draft]") != null,
  };
}

/** Where a form sits: its DirtyForm label and the CreateDisclosure around it. */
function place(form: HTMLFormElement) {
  return {
    label: form.getAttribute(LABEL_ATTR) ?? undefined,
    disclosure: form.closest(`[${DISCLOSURE_ATTR}]`)?.getAttribute(DISCLOSURE_ATTR) ?? undefined,
  };
}

function inScope(form: HTMLFormElement) {
  return form.closest(".dash") != null && !form.hasAttribute("data-no-draft");
}

/** Forms of the page that look like `form` (same fields, label and disclosure), in page order. */
function siblings(sig: string, label: string | undefined, disclosure: string | undefined): HTMLFormElement[] {
  return Array.from(document.forms).filter((f) => {
    if (!inScope(f)) return false;
    const p = place(f);
    return p.label === label && p.disclosure === disclosure && formSignature(controls(f).map((c) => c.name)) === sig;
  });
}

function capture(form: HTMLFormElement, now: number): FormDraft | null {
  const els = controls(form);
  const fields = draftFields(els.map(info));
  if (!fields.length) return null;
  const sig = formSignature(els.map((c) => c.name));
  const { label, disclosure } = place(form);
  const index = Math.max(0, siblings(sig, label, disclosure).indexOf(form));
  return { path: location.pathname, sig, index, label, disclosure, fields, at: now };
}

/** Keeps a copy of these forms' values (called right before they are saved). */
export function rememberForms(forms: HTMLFormElement[]) {
  const now = Date.now();
  const added = forms.filter(inScope).map((f) => capture(f, now)).filter((d): d is FormDraft => d != null);
  if (added.length) writeDrafts(mergeDrafts(readDrafts(), added, now));
}

/** True when the page came back with an error for a form of this CreateDisclosure: it reopens. */
export function reopenAfterError(title: string): boolean {
  if (typeof window === "undefined" || !flashError(location.search)) return false;
  return freshDrafts(readDrafts(), location.pathname, Date.now()).some((d) => d.disclosure === title);
}

function findForm(d: FormDraft): HTMLFormElement | null {
  return siblings(d.sig, d.label, d.disclosure)[d.index] ?? null;
}

function setValue(el: Control, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  // The native setter, so React-controlled fields see the change through their onChange.
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Puts the kept values back: choices first (they may show other fields), then the text. */
async function apply(form: HTMLFormElement, d: FormDraft) {
  for (const pass of ["choice", "text"] as const) {
    const els = controls(form);
    for (const step of restorePlan(els.map(info), d.fields)) {
      const el = els[step.index];
      const isChoice = el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio"));
      if ((pass === "choice") !== isChoice) continue;
      if (step.checked !== undefined && el instanceof HTMLInputElement) el.click();
      else if (step.value !== undefined) setValue(el, step.value);
    }
    await frame();
  }
}

function describedBy(el: Element, id: string, add: boolean) {
  const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((x) => x && x !== id);
  if (add) ids.push(id);
  if (ids.length) el.setAttribute("aria-describedby", ids.join(" "));
  else el.removeAttribute("aria-describedby");
}

function clearMark(id: string) {
  document.getElementById(id)?.remove();
  document.querySelectorAll(`[${INVALID_ATTR}="${CSS.escape(id)}"]`).forEach((el) => {
    el.removeAttribute("aria-invalid");
    el.removeAttribute(INVALID_ATTR);
    describedBy(el, id, false);
  });
}

function clearAllMarks() {
  document.querySelectorAll(`[${MESSAGE_ATTR}]`).forEach((m) => clearMark(m.id));
}

const isVisibleControl = (el: Control) => !(el instanceof HTMLInputElement && el.type === "hidden") && !el.disabled;

/** The largest wrapper holding this field only (its label, hint, suffix…): the message goes at its end. */
function wrapperOf(el: Control, form: HTMLFormElement, name: string): Element {
  let box: Element = el;
  while (box.parentElement && box.parentElement !== form) {
    const parent: HTMLElement = box.parentElement;
    const others = Array.from(parent.querySelectorAll<Control>("input, select, textarea")).some((c) => c.name !== name && isVisibleControl(c));
    if (others) break;
    box = parent;
  }
  return box;
}

let markSeq = 0;

/** aria-invalid + an inline message (aria-describedby) on the named fields; returns the first one. */
function markFields(form: HTMLFormElement, names: string[], message: string): Control | null {
  let first: Control | null = null;
  for (const name of names) {
    const els = controls(form).filter((c) => c.name === name && isVisibleControl(c));
    if (!els.length) continue;
    const id = `erreur-champ-${++markSeq}`;
    const msg = document.createElement("span");
    msg.id = id;
    msg.setAttribute(MESSAGE_ATTR, name);
    msg.className = "field-error mt-1.5 flex items-start gap-1 text-xs leading-snug font-medium text-red-700 col-span-full";
    msg.textContent = message;
    const box = wrapperOf(els[els.length - 1], form, name);
    const row = box.parentElement;
    const rowStyle = row ? getComputedStyle(row) : null;
    if (row && rowStyle?.display.includes("flex") && rowStyle.flexWrap === "wrap" && box.getBoundingClientRect().width < 240) {
      // A narrow field in a wrapping row (a table row form): the message gets a line of its own.
      msg.classList.add("basis-full");
      row.appendChild(msg);
    } else if (box !== els[els.length - 1] && box.tagName !== "LABEL") {
      // Inside the field's own wrapper (label, hint, suffix…).
      box.appendChild(msg);
    } else {
      // Right after the control / label (full width when that lands in the form's grid).
      box.after(msg);
    }
    for (const el of els) {
      el.setAttribute("aria-invalid", "true");
      el.setAttribute(INVALID_ATTR, id);
      describedBy(el, id, true);
      const onEdit = () => {
        clearMark(id);
        el.removeEventListener("input", onEdit);
        el.removeEventListener("change", onEdit);
      };
      // Registered after the restore's own events: the first edit by the merchant clears the flag.
      el.addEventListener("input", onEdit);
      el.addEventListener("change", onEdit);
    }
    first ??= els[0];
  }
  return first;
}

let restoring = 0;

/** After a navigation: restore the kept forms if the page shows an error, else forget them. */
async function restoreFromUrl() {
  const run = ++restoring;
  clearAllMarks();
  const flash = flashError(location.search);
  const drafts = freshDrafts(readDrafts(), location.pathname, Date.now());
  if (!flash) {
    if (drafts.length) writeDrafts(readDrafts().filter((d) => d.path !== location.pathname));
    return;
  }
  const target = draftForError(drafts, flash.form);
  // The new page renders (and a CreateDisclosure reopens) in the next frames: wait for the forms.
  const found = new Map<FormDraft, HTMLFormElement>();
  for (let i = 0; i < 40 && found.size < drafts.length; i++) {
    for (const d of drafts) if (!found.has(d)) {
      const f = findForm(d);
      if (f) found.set(d, f);
    }
    if (target && found.has(target)) break;
    await new Promise((r) => setTimeout(r, 50));
    if (run !== restoring) return;
  }
  for (const [d, f] of found) {
    // An edit form folded in a <details> ("Modifier") unfolds again, with its values.
    for (let el = f.parentElement; el; el = el.parentElement) if (el instanceof HTMLDetailsElement && !el.open) el.open = true;
    await apply(f, d);
  }
  if (run !== restoring) return;
  writeDrafts(readDrafts().filter((d) => d.path !== location.pathname));
  // The field at fault: in the form the error is about, else the only form of the page having it.
  let form = target ? found.get(target) : undefined;
  if (!form && flash.fields.length) {
    const having = Array.from(document.forms).filter((f) => inScope(f) && controls(f).some((c) => flash.fields.includes(c.name) && isVisibleControl(c)));
    if (having.length === 1) form = having[0];
  }
  if (!form || !flash.fields.length) return;
  const first = markFields(form, flash.fields, inlineMessage(flash.error, flash.form));
  if (first && target) {
    // Straight to the field to fix (the banner above keeps announcing the error).
    first.focus({ preventScroll: true });
    first.scrollIntoView({ block: "center" });
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
function scheduleRestore(delay = 60) {
  clearTimeout(timer);
  timer = setTimeout(() => void restoreFromUrl(), delay);
}

/**
 * Mounted once in the store layout: copies a form's values when it is submitted, and after the
 * action's redirect puts them back (with the field at fault flagged) or forgets them.
 */
export function FormDraftKeeper() {
  const pathname = usePathname();
  const search = useSearchParams().toString();

  useEffect(() => {
    let poll: ReturnType<typeof setInterval> | undefined;
    const onSubmit = (e: SubmitEvent) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement) || !inScope(form)) return;
      rememberForms([form]);
      // The redirect may land on the very same URL (same error twice): no search change to
      // react to, but the page re-renders and drops the form — watch for that.
      const href = location.href;
      const started = Date.now();
      clearInterval(poll);
      poll = setInterval(() => {
        if (location.href !== href || !form.isConnected) {
          clearInterval(poll);
          scheduleRestore();
        } else if (Date.now() - started > 30_000) clearInterval(poll);
      }, 100);
    };
    document.addEventListener("submit", onSubmit, true);
    return () => {
      document.removeEventListener("submit", onSubmit, true);
      clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    scheduleRestore();
  }, [pathname, search]);

  return null;
}
