/**
 * Read-only mode of a store's pages (viewers): the forms that change something — server actions
 * (React renders them with `method="post"`, a `$ACTION_…` hidden input, or a `javascript:` action
 * placeholder) and plain POST forms — get their controls locked, so a viewer isn't bounced after
 * filling one in. GET forms (filters, period, search) and links keep working. A form marked
 * `data-readonly-allow` is left alone.
 */

export const LOCK_ATTR = "data-readonly-lock";
export const READ_ONLY_TITLE = "Lecture seule : vous ne pouvez pas modifier cette boutique.";

const TEXT_LIKE = new Set(["text", "email", "number", "search", "tel", "url", "password", "date", "datetime-local", "month", "time", "week", ""]);

const isActionAttr = (v: string | null) => !!v && v.trim().toLowerCase().startsWith("javascript:");

/** `form` submits a change (a server action or a POST), not a navigation. */
export function isEditForm(form: HTMLFormElement): boolean {
  if (form.hasAttribute("data-readonly-allow")) return false;
  if ((form.getAttribute("method") ?? "").toLowerCase() === "post") return true;
  if (isActionAttr(form.getAttribute("action"))) return true;
  return !!form.querySelector('input[name^="$ACTION_"]');
}

/** A submit button carrying its own server action (`formAction`), even inside a GET form. */
function isActionButton(el: Element): boolean {
  if (!(el instanceof HTMLButtonElement || el instanceof HTMLInputElement)) return false;
  if (el.closest("form[data-readonly-allow]")) return false;
  return isActionAttr(el.getAttribute("formaction")) || (el.getAttribute("name") ?? "").startsWith("$ACTION_");
}

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement | HTMLFieldSetElement;

function lock(el: Control) {
  // Text stays selectable / copyable: text fields become read-only, the rest disabled.
  if ((el instanceof HTMLInputElement && TEXT_LIKE.has(el.type)) || el instanceof HTMLTextAreaElement) {
    if (el.type === "hidden") return;
    if (!el.readOnly) el.readOnly = true;
    if (!el.hasAttribute(LOCK_ATTR)) el.setAttribute(LOCK_ATTR, "");
    return;
  }
  if (el instanceof HTMLInputElement && el.type === "hidden") return;
  if (!el.disabled) el.disabled = true;
  if (!el.hasAttribute(LOCK_ATTR)) {
    el.setAttribute(LOCK_ATTR, "");
    if (el instanceof HTMLButtonElement || (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button"))) el.title = READ_ONLY_TITLE;
  }
}

/** Locks every editing control under `root` (idempotent: only touches what isn't locked yet). */
export function lockEditForms(root: ParentNode): number {
  let n = 0;
  for (const form of Array.from(root.querySelectorAll("form"))) {
    if (!isEditForm(form)) continue;
    // form.elements also lists the controls placed outside it with form="…".
    for (const el of Array.from(form.elements) as Control[]) {
      if (el instanceof HTMLInputElement && el.type === "hidden") continue;
      if (el.hasAttribute(LOCK_ATTR) && (el.disabled || ("readOnly" in el && el.readOnly))) continue;
      lock(el);
      n++;
    }
  }
  for (const el of Array.from(root.querySelectorAll("button[formaction], input[formaction], button[name^='$ACTION_']"))) {
    if (!isActionButton(el)) continue;
    const c = el as HTMLButtonElement;
    if (c.hasAttribute(LOCK_ATTR) && c.disabled) continue;
    lock(c);
    n++;
  }
  return n;
}
