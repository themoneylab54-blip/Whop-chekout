import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Store } from "@prisma/client";
import { checkoutHostRedirect, queryOf } from "@/lib/checkout-domain";
import { env } from "@/lib/env";
import { appExtraHosts } from "@/lib/host-guard";

/**
 * Keeps a /c page on the store's own host: its verified checkout domain (checkout.seyuna.com), or
 * APP_URL when it has none. Local and preview hosts are left alone, and so is APP_URL when the
 * loader fell back to it (?via=app: the checkout domain was unreachable for this buyer).
 */
export async function keepOnCheckoutHost(
  store: Pick<Store, "checkoutDomain" | "checkoutDomainVerifiedAt">,
  path: string,
  searchParams: Record<string, string | string[] | undefined>,
): Promise<void> {
  const h = await headers();
  // via=app: the loader could not reach the checkout domain and created the session on APP_URL.
  const target = checkoutHostRedirect(store, h.get("host"), `${path}${queryOf(searchParams)}`, env.appUrl, appExtraHosts(), { viaApp: searchParams.via === "app" });
  if (target) redirect(target);
}
