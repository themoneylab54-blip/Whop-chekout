/**
 * Flash messages of dashboard server actions: the action redirects back to the page with
 * `?ok=` or `?error=`, and for a validation error also `field=` (the name of the form field at
 * fault, shown inline next to it) and `form=` (the DirtyForm label, when several forms were
 * saved at once). The page restores what was typed (see FormDraftKeeper).
 */
export type FlashParams = { ok?: string; error?: string; field?: string; form?: string };

export function flashQuery(params: FlashParams = {}): URLSearchParams {
  const q = new URLSearchParams();
  if (params.ok) q.set("ok", params.ok);
  if (params.error) {
    q.set("error", params.error);
    // A field only means something next to an error.
    if (params.field) q.set("field", params.field);
    if (params.form) q.set("form", params.form);
  }
  return q;
}

/** `path` + the flash parameters (appended to a query string `path` may already have) + `hash`. */
export function flashUrl(path: string, params: FlashParams = {}, hash = ""): string {
  const q = flashQuery(params);
  return `${q.size ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path}${hash}`;
}

/** The field of the first zod issue (its top-level key), for `field=`. */
export function issueField(issues: readonly { path: readonly PropertyKey[] }[] | undefined): string | undefined {
  const key = issues?.[0]?.path?.[0];
  return typeof key === "string" ? key : undefined;
}
