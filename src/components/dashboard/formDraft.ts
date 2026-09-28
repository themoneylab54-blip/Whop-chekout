/*
 * Typed values of a dashboard form kept across a failed save.
 *
 * Dashboard forms post to server actions that redirect back with `?error=` (and `field=` for a
 * validation error). That navigation re-renders the page and drops what was typed, and a form
 * inside a « + Ajouter… » disclosure even closes. So, right before a form is submitted, its
 * visible fields are copied to sessionStorage (this tab only, a couple of minutes); when the page
 * comes back with an error, the same form gets its values back, its disclosure reopens and the
 * field named by `field=` is flagged inline (aria-invalid + message). A success drops the copy.
 *
 * Pure helpers (no DOM) live here so they can be unit-tested; FormDraftKeeper does the DOM side.
 */

export const DRAFT_STORAGE_KEY = "wc:form-drafts";
/** A draft older than this is ignored (the error page was reloaded later, another visit…). */
export const DRAFT_TTL_MS = 2 * 60_000;

/** One form control as read from the DOM. */
export type ControlInfo = { name: string; type: string; value: string; checked?: boolean; noDraft?: boolean };

export type DraftField = { name: string; value: string; checked?: boolean };

export type FormDraft = {
  /** Page (pathname) the form was submitted from. */
  path: string;
  /** Names of the form's fields: identifies "the same form" once the page re-rendered. */
  sig: string;
  /** Rank among the page's forms with the same signature (one form per table row…). */
  index: number;
  /** DirtyForm label (the batch save names the section at fault with `form=`). */
  label?: string;
  /** Title of the CreateDisclosure holding the form: it reopens. */
  disclosure?: string;
  fields: DraftField[];
  at: number;
};

/** Fields that never go to storage: secrets, files, buttons, hidden plumbing, React action ids. */
const SECRET_NAME = /(secret|password|passwd|token|api_?key|private_?key|resendapikey|relaykey)$/i;
const SKIPPED_TYPES = new Set(["hidden", "file", "password", "submit", "button", "reset", "image"]);

export function isStorable(c: ControlInfo): boolean {
  if (!c.name || c.noDraft || c.name.startsWith("$ACTION")) return false;
  if (SKIPPED_TYPES.has(c.type)) return false;
  return !SECRET_NAME.test(c.name);
}

/** Identity of a form: its field names (all of them, hidden ones included), sorted, unique. */
export function formSignature(names: readonly string[]): string {
  return [...new Set(names.filter((n) => n && !n.startsWith("$ACTION")))].sort().join("|");
}

/** The values to keep for a form's controls (checkboxes and radios keep their state). */
export function draftFields(controls: readonly ControlInfo[]): DraftField[] {
  return controls.filter(isStorable).map((c) => (c.type === "checkbox" || c.type === "radio" ? { name: c.name, value: c.value, checked: !!c.checked } : { name: c.name, value: c.value }));
}

/** Drafts from storage, tolerant to anything (old shape, manual edit, quota): never throws. */
export function parseDrafts(raw: string | null | undefined): FormDraft[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (d): d is FormDraft =>
        !!d && typeof d === "object" && typeof d.path === "string" && typeof d.sig === "string" && typeof d.index === "number" && typeof d.at === "number" && Array.isArray(d.fields),
    );
  } catch {
    return [];
  }
}

/** Drafts still worth restoring on `path` at `now`. */
export function freshDrafts(drafts: readonly FormDraft[], path: string, now: number): FormDraft[] {
  return drafts.filter((d) => d.path === path && now - d.at >= 0 && now - d.at <= DRAFT_TTL_MS);
}

/** Replaces the drafts of the same forms (same page, signature and rank) with the new ones. */
export function mergeDrafts(existing: readonly FormDraft[], added: readonly FormDraft[], now: number): FormDraft[] {
  const same = (a: FormDraft, b: FormDraft) => a.path === b.path && a.sig === b.sig && a.index === b.index;
  return [...existing.filter((d) => now - d.at <= DRAFT_TTL_MS && !added.some((x) => same(x, d))), ...added];
}

/** The error flash of a URL query: the message, the field(s) at fault and the form named. */
export function flashError(search: string | URLSearchParams): { error: string; fields: string[]; form?: string } | null {
  const q = typeof search === "string" ? new URLSearchParams(search) : search;
  const error = q.get("error");
  if (!error) return null;
  const fields = (q.get("field") ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  return { error, fields, form: q.get("form") ?? undefined };
}

/**
 * The draft the error is about: the form named by `form=` (a batch save of several sections),
 * else the most recently submitted one.
 */
export function draftForError(drafts: readonly FormDraft[], form?: string): FormDraft | null {
  if (!drafts.length) return null;
  if (form) {
    const named = drafts.filter((d) => d.label === form);
    if (named.length) return named.reduce((a, b) => (b.at >= a.at ? b : a));
  }
  return drafts.reduce((a, b) => (b.at >= a.at ? b : a));
}

/**
 * Values to set on a form's controls, per control (in document order): text-like controls of
 * the same name are matched by rank, checkboxes / radios by value. Unchanged controls are left out.
 */
export function restorePlan(controls: readonly ControlInfo[], fields: readonly DraftField[]): { index: number; value?: string; checked?: boolean }[] {
  const plan: { index: number; value?: string; checked?: boolean }[] = [];
  const rank = new Map<string, number>();
  controls.forEach((c, index) => {
    if (!isStorable(c)) return;
    if (c.type === "checkbox" || c.type === "radio") {
      const f = fields.find((x) => x.name === c.name && x.value === c.value && x.checked !== undefined);
      if (f && !!f.checked !== !!c.checked) plan.push({ index, checked: !!f.checked });
      return;
    }
    const r = rank.get(c.name) ?? 0;
    rank.set(c.name, r + 1);
    const f = fields.filter((x) => x.name === c.name && x.checked === undefined)[r];
    if (f && f.value !== c.value) plan.push({ index, value: f.value });
  });
  return plan;
}

/**
 * The message shown next to the field: the batch save's "<section> : <error> (déjà enregistré :
 * …)" becomes "<error>" (the banner keeps the full sentence).
 */
export function inlineMessage(error: string, form?: string): string {
  if (!form || !error.startsWith(`${form} : `)) return error;
  return error.slice(form.length + 3).replace(/ \(déjà enregistré : [^)]*\)$/, "");
}
