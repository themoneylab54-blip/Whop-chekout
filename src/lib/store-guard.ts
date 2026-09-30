import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Store } from "@prisma/client";
import type { SessionUser } from "./auth";
import { checkStoreAccess, storeRefusalCode, type AccessLevel } from "./access";
import { flashUrl } from "./flash";

/**
 * The page a refused store action goes back to: the referring page when it is one of this store's
 * dashboard pages (the viewer stays where they clicked), else the store's overview.
 */
export function refusalPath(storeId: string, referer: string | null | undefined): string {
  const base = `/dashboard/stores/${storeId}`;
  if (!referer) return base;
  try {
    const u = new URL(referer, "http://x");
    if (u.pathname === base || u.pathname.startsWith(`${base}/`)) {
      // The previous flash is dropped (the refusal replaces it).
      for (const k of ["ok", "error", "field", "form", "saved"]) u.searchParams.delete(k);
      const q = u.searchParams.toString();
      return `${u.pathname}${q ? `?${q}` : ""}`;
    }
  } catch {
    /* unparsable referer: the overview */
  }
  return base;
}

/**
 * For store-scoped server actions: like requireStoreAccess, but a user whose role is too low is sent
 * back to the page they came from (Referer, when it is this store's) with the refusal, not to the
 * store's overview.
 */
export async function requireStoreAction(storeId: string, level: AccessLevel): Promise<{ user: SessionUser; store: Store }> {
  const res = await checkStoreAccess(storeId, level);
  if (res.ok) return { user: res.user, store: res.store };
  if (res.reason === "login") redirect("/login");
  if (res.reason === "notFound") redirect("/dashboard");
  let referer: string | null = null;
  try {
    referer = (await headers()).get("referer");
  } catch {
    /* outside a request */
  }
  // A code: the store pages show its fixed text (STORE_ACCESS_ERRORS), nothing typed travels in the URL.
  redirect(flashUrl(refusalPath(storeId, referer), { error: storeRefusalCode(level) }));
}
