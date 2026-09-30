"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireStoreAction } from "@/lib/store-guard";
import { db } from "@/lib/db";
import { syncOrderSafely } from "@/lib/checkout";

const idsSchema = z.array(z.string().min(1).max(64)).min(1, "Sélectionnez au moins une commande").max(100, "100 commandes maximum à la fois");

/** Bulk "Relancer la synchro Shopify" on the selected paid orders that have no Shopify order yet. */
export async function resyncOrdersAction(storeId: string, fd: FormData) {
  await requireStoreAction(storeId, "edit");
  const back = String(fd.get("back") ?? "");
  const path = back.startsWith(`/dashboard/stores/${storeId}/orders`) ? back : `/dashboard/stores/${storeId}/orders`;
  const go = (p: { ok?: string; error?: string }) => {
    const u = new URL(path, "http://x");
    u.searchParams.delete("ok");
    u.searchParams.delete("error");
    for (const [k, v] of Object.entries(p)) if (v) u.searchParams.set(k, v);
    redirect(`${u.pathname}${u.search}`);
  };
  const parsed = idsSchema.safeParse(fd.getAll("ids").map(String));
  if (!parsed.success) go({ error: parsed.error.issues[0]?.message });
  const targets = await db.checkoutSession.findMany({
    where: { id: { in: parsed.data! }, storeId, status: "PAID", shopifyOrderId: null },
    select: { id: true, reviewNote: true },
  });
  const held = targets.filter((t) => t.reviewNote).length;
  let done = 0;
  for (const t of targets.filter((x) => !x.reviewNote)) {
    await syncOrderSafely(t.id);
    done++;
  }
  const synced = await db.checkoutSession.count({ where: { id: { in: targets.map((t) => t.id) }, shopifyOrderId: { not: null } } });
  revalidatePath(`/dashboard/stores/${storeId}/orders`);
  const skipped = parsed.data!.length - targets.length;
  const parts = [
    done ? `Synchro relancée pour ${done} commande(s) : ${synced} créée(s) dans Shopify.` : "Aucune commande à synchroniser.",
    held ? `${held} en attente de vérification (à valider depuis la commande).` : "",
    skipped ? `${skipped} déjà synchronisée(s) ou non payée(s), ignorée(s).` : "",
  ];
  go(done && synced < done ? { error: `${parts.join(" ")} Les autres restent en erreur : voir le détail de la commande.`.trim() } : { ok: parts.filter(Boolean).join(" ") });
}
