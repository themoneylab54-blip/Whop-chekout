import "server-only";
import { Prisma, type CheckoutTest } from "@prisma/client";
import { z } from "zod";
import { db } from "./db";
import { bucketOf } from "./experiments";
import { recordEvent } from "./log";
import { loadCheckoutLayout, type Block } from "./layout";
import { validateQuantityTiers, type ProtectionPricing } from "./pricing";

/*
 * A/B tests of checkout elements beyond the design and the post-purchase offers:
 *  - "breaks": a second set of quantity-break tiers (arm B) against the store's tiers (arm A);
 *  - "addon": an order bump's price and/or visibility (hidden in B);
 *  - "protection": the shipping protection's pricing (fixed price or percent, min / max).
 * Arm B goes to `splitB` % of visitors, sticky per visitor (the same bucket hash as the design
 * tests); each checkout records its arms (CheckoutSession.checkoutTestArms) when it opens, and the
 * quote, the page and the paid snapshot all read arm B's settings from there, so a buyer sees and
 * pays one arm only. Results reuse the design-test engine (analyze → decide) on the margin per
 * visitor (Analytics' per-order margin, after costs and fees): a cheaper arm that sells more but
 * earns less never wins. "Promouvoir B" writes B into the store's settings; "Garder A" only stops.
 *
 * Residual risk (accepted, documented in the README): the arm is sticky per signed visitor id, not
 * per person. A buyer who comes back without it (cookies cleared, another browser or device, private
 * window) gets a new id and may be drawn into the other arm, so they can see two prices for the same
 * element across visits. Binding the arm to the e-mail or the Shopify cart token isn't done: the
 * e-mail is only known once the checkout is open (after the arm decided the page), and a cart token
 * changes with the cart. What is guaranteed: one checkout = one arm (frozen on the session), so a
 * buyer always pays the price that checkout showed.
 */

export type CheckoutTestKind = "breaks" | "addon" | "protection";
export const CHECKOUT_TEST_KINDS: Record<CheckoutTestKind, string> = {
  breaks: "Paliers de remise quantité",
  addon: "Option (order bump) : prix ou affichage",
  protection: "Prix de la protection colis",
};
export const MAX_RUNNING_CHECKOUT_TESTS = 3;

export type AddonConfig = { priceCents?: number; hidden?: boolean };
export type ProtectionConfig = Pick<ProtectionPricing, "priceMode" | "price" | "percent" | "minPrice" | "maxPrice">;

const addonSchema = z
  .object({ priceCents: z.number().int().min(0).max(10_000_000).optional(), hidden: z.boolean().optional() })
  .refine((c) => c.priceCents != null || c.hidden === true, "Arm B must change the price or hide the option");
/** Arm A's snapshot of a bump (its price and visibility when the test started). */
const addonSnapshotSchema = z.object({ priceCents: z.number().int().min(0).max(10_000_000).optional(), hidden: z.boolean().optional() });
const protectionSchema = z.object({
  priceMode: z.enum(["fixed", "percent"]),
  price: z.number().min(0).max(1000),
  percent: z.number().min(0).max(50),
  minPrice: z.number().min(0).max(1000),
  maxPrice: z.number().min(0).max(1000),
});

/** Arm B's settings validated for a kind, or the error to show. Pure. */
export function checkTestConfig(kind: string, raw: unknown): { ok: true; config: unknown } | { ok: false; error: string } {
  if (kind === "breaks") {
    const v = validateQuantityTiers(raw);
    if (!v.ok) return { ok: false, error: `Paliers B : ${v.error}` };
    if (!v.tiers.length) return { ok: false, error: "Paliers B : ajoutez au moins un palier." };
    return { ok: true, config: v.tiers };
  }
  if (kind === "addon") {
    const v = addonSchema.safeParse(raw);
    return v.success ? { ok: true, config: v.data } : { ok: false, error: "Option B : indiquez un autre prix ou masquez l'option." };
  }
  if (kind === "protection") {
    const v = protectionSchema.safeParse(raw);
    return v.success ? { ok: true, config: v.data } : { ok: false, error: "Protection B : prix invalide." };
  }
  return { ok: false, error: "Type de test inconnu." };
}

/** Arm of a visitor in a test: sticky per visitor id, a random draw without one. Pure except the draw. */
export function armOf(visitorId: string | null, testId: string, splitB: number): "A" | "B" {
  const bucket = visitorId ? bucketOf(visitorId, testId) : Math.random() * 100;
  return bucket < splitB ? "B" : "A";
}

/** Arms of a new checkout in the store's running checkout tests (null when none runs). */
export async function assignCheckoutTests(storeId: string, visitorId: string | null): Promise<Record<string, "A" | "B"> | null> {
  const running = await db.checkoutTest.findMany({ where: { storeId, status: "RUNNING" }, select: { id: true, splitB: true } });
  if (!running.length) return null;
  return Object.fromEntries(running.map((t) => [t.id, armOf(visitorId, t.id, t.splitB)]));
}

export type TestOverrides = {
  /** Quantity-break tiers of arm B (raw, parsed like Store.quantityBreaks). */
  breaks?: unknown;
  addOns: Map<string, AddonConfig>;
  protection?: ProtectionConfig;
};

const NONE: TestOverrides = { addOns: new Map() };

/**
 * Settings of the running tests a checkout is in: arm B's, and for arm A the settings frozen when
 * the test started (configA) — an edit of the store's tiers, bump or protection price during the
 * test would otherwise change arm A halfway and blur the comparison.
 */
export async function overridesFor(session: { storeId: string; checkoutTestArms: unknown }): Promise<TestOverrides> {
  const arms = session.checkoutTestArms as Record<string, string> | null;
  const ids = arms && typeof arms === "object" ? Object.entries(arms).filter(([, a]) => a === "A" || a === "B").map(([id]) => id) : [];
  if (!ids.length) return NONE;
  const tests = await db.checkoutTest.findMany({ where: { id: { in: ids }, storeId: session.storeId, status: "RUNNING" } });
  return overridesOf(tests.map((t) => ({ ...t, arm: arms![t.id] === "A" ? ("A" as const) : ("B" as const) })));
}

/** Overrides of the tests a checkout is in (arm B's settings, or arm A's frozen ones). Pure. */
export function overridesOf(tests: (Pick<CheckoutTest, "kind" | "targetId" | "configB"> & { configA?: unknown; arm?: "A" | "B" })[]): TestOverrides {
  const out: TestOverrides = { addOns: new Map() };
  for (const t of tests) {
    const config = t.arm === "A" ? t.configA : t.configB;
    // Arm A without a snapshot (older tests): the store's current settings.
    if (config == null) continue;
    if (t.kind === "breaks") out.breaks = config;
    else if (t.kind === "addon" && t.targetId) {
      const v = (t.arm === "A" ? addonSnapshotSchema : addonSchema).safeParse(config);
      if (v.success) out.addOns.set(t.targetId, v.data);
    } else if (t.kind === "protection") {
      const v = protectionSchema.safeParse(config);
      if (v.success) out.protection = v.data;
    }
  }
  return out;
}

/** Order bumps as arm B shows them: hidden ones removed, prices replaced. Pure. */
export function withAddOnOverrides<T extends { id: string; priceCents: number }>(rows: T[], o: TestOverrides): T[] {
  if (!o.addOns.size) return rows;
  return rows.filter((a) => !o.addOns.get(a.id)?.hidden).map((a) => (o.addOns.get(a.id)?.priceCents != null ? { ...a, priceCents: o.addOns.get(a.id)!.priceCents! } : a));
}

/** Shipping protection props with arm B's pricing. Pure. */
export function withProtectionOverride<P extends ProtectionConfig>(props: P, o: TestOverrides): P {
  return o.protection ? { ...props, ...o.protection } : props;
}

/** A checkout layout whose shipping protection block carries arm B's pricing. Pure. */
export function layoutWithOverrides(raw: unknown, o: TestOverrides): unknown {
  if (!o.protection) return raw;
  const layout = loadCheckoutLayout(raw);
  return { ...layout, blocks: layout.blocks.map((b: Block) => (b.type === "shipping_protection" ? { ...b, props: withProtectionOverride(b.props, o) } : b)) };
}

/* ------------------------------------------------------------------ */
/* Starting, stopping and promoting                                    */
/* ------------------------------------------------------------------ */

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === "P2002" || (err.code === "P2010" && /23505/.test(JSON.stringify(err.meta ?? {})));
  return /23505|unique constraint/i.test(err instanceof Error ? err.message : "");
}

/** The running tests of a store, by element ("breaks", "protection", "addon:<id>"), for the editors' warnings. */
export async function runningTestsByElement(storeId: string): Promise<Map<string, { id: string; name: string }>> {
  const rows = await db.checkoutTest.findMany({ where: { storeId, status: "RUNNING" }, select: { id: true, name: true, kind: true, targetId: true } });
  return new Map(rows.map((t) => [t.kind === "addon" ? `addon:${t.targetId}` : t.kind, { id: t.id, name: t.name }]));
}

/** What arm A is today (restored by "Garder A", shown next to B). */
export async function currentConfig(storeId: string, kind: CheckoutTestKind, targetId: string | null): Promise<unknown> {
  const store = await db.store.findUnique({ where: { id: storeId }, select: { quantityBreaks: true, checkoutLayout: true } });
  if (kind === "breaks") return store?.quantityBreaks ?? [];
  if (kind === "addon") {
    const a = targetId ? await db.addOn.findFirst({ where: { id: targetId, storeId }, select: { priceCents: true, active: true } }) : null;
    return a ? { priceCents: a.priceCents, hidden: !a.active } : null;
  }
  const block = loadCheckoutLayout(store?.checkoutLayout).blocks.find((b) => b.type === "shipping_protection");
  if (block?.type !== "shipping_protection") return null;
  const { priceMode, price, percent, minPrice, maxPrice } = block.props;
  return { priceMode, price, percent, minPrice, maxPrice };
}

export async function startCheckoutTest(
  storeId: string,
  input: { kind: string; targetId?: string | null; name: string; splitB: number; configB: unknown },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const kind = input.kind as CheckoutTestKind;
  if (!(kind in CHECKOUT_TEST_KINDS)) return { ok: false, error: "Type de test inconnu." };
  const checked = checkTestConfig(kind, input.configB);
  if (!checked.ok) return checked;
  const splitB = Math.round(input.splitB);
  if (!(splitB >= 5 && splitB <= 95)) return { ok: false, error: "Part de B : entre 5 et 95 %." };
  const running = await db.checkoutTest.findMany({ where: { storeId, status: "RUNNING" }, select: { kind: true, targetId: true } });
  if (running.length >= MAX_RUNNING_CHECKOUT_TESTS) return { ok: false, error: `${MAX_RUNNING_CHECKOUT_TESTS} tests du checkout au plus en même temps.` };
  const targetId = kind === "addon" ? (input.targetId ?? null) : null;
  if (kind === "addon" && !(targetId && (await db.addOn.findFirst({ where: { id: targetId, storeId }, select: { id: true } })))) return { ok: false, error: "Choisissez l'option à tester." };
  if (running.some((t) => t.kind === kind && (kind !== "addon" || t.targetId === targetId))) return { ok: false, error: "Un test de cet élément est déjà en cours." };
  if (kind === "protection" && !(await currentConfig(storeId, kind, null))) return { ok: false, error: "Ajoutez d'abord le bloc « Protection colis » au checkout." };
  const test = await db.checkoutTest
    .create({
      data: {
      storeId,
      kind,
      targetId,
      name: input.name.trim().slice(0, 80) || CHECKOUT_TEST_KINDS[kind],
      splitB,
      configB: checked.config as Prisma.InputJsonValue,
        configA: ((await currentConfig(storeId, kind, targetId)) ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      },
    })
    // Two starts at once: the partial unique index keeps one running test per element.
    .catch((err: unknown) => {
      if (isUniqueViolation(err)) return null;
      throw err;
    });
  if (!test) return { ok: false, error: "Un test de cet élément est déjà en cours." };
  await recordEvent({ storeId, kind: "checkout_test.started", message: `Test A/B du checkout lancé : « ${test.name} » (${CHECKOUT_TEST_KINDS[kind]}, ${splitB} % en B).`, data: { testId: test.id } });
  return { ok: true, id: test.id };
}

/**
 * Ends a running test. keep "B": arm B's settings become the store's (tiers, the bump's price /
 * visibility, the protection block's pricing in the published layout and the draft); "A": stop only.
 */
export async function endCheckoutTest(storeId: string, testId: string, keep: "A" | "B", how: "manual" | "auto" = "manual"): Promise<boolean> {
  const test = await db.checkoutTest.findFirst({ where: { id: testId, storeId, status: "RUNNING" } });
  if (!test) return false;
  // One transaction: the test stops and B becomes the store's setting together, or neither happens
  // (a failed promote never leaves a stopped test whose winner wasn't applied).
  const done = await db.$transaction(async (tx) => {
    const stopped = await tx.checkoutTest.updateMany({ where: { id: testId, status: "RUNNING" }, data: { status: "STOPPED", endedAt: new Date(), winner: keep } });
    if (!stopped.count) return false;
    if (keep === "B") {
      if (test.kind === "breaks") await tx.store.update({ where: { id: storeId }, data: { quantityBreaks: test.configB as Prisma.InputJsonValue } });
      else if (test.kind === "addon" && test.targetId) {
        const c = test.configB as AddonConfig;
        await tx.addOn.updateMany({ where: { id: test.targetId, storeId }, data: { ...(c.priceCents != null ? { priceCents: c.priceCents } : {}), ...(c.hidden ? { active: false } : {}) } });
      } else if (test.kind === "protection") {
        // Row lock: a layout saved meanwhile isn't overwritten with a stale copy.
        await tx.$queryRaw`SELECT 1 FROM "Store" WHERE id = ${storeId} FOR UPDATE`;
        const store = await tx.store.findUnique({ where: { id: storeId }, select: { checkoutLayout: true, draftCheckoutLayout: true } });
        const o = overridesOf([test]);
        await tx.store.update({
          where: { id: storeId },
          data: {
            checkoutLayout: layoutWithOverrides(store?.checkoutLayout, o) as Prisma.InputJsonValue,
            ...(store?.draftCheckoutLayout != null ? { draftCheckoutLayout: layoutWithOverrides(store.draftCheckoutLayout, o) as Prisma.InputJsonValue } : {}),
          },
        });
      }
    }
    return true;
  });
  if (!done) return false;
  await recordEvent({
    storeId,
    level: how === "auto" ? "warn" : "info",
    kind: "checkout_test.decided",
    message: `Test A/B du checkout « ${test.name} » : ${keep === "B" ? "variante B promue, elle devient le réglage de la boutique" : "variante A conservée"}${how === "auto" ? " (automatiquement)" : ""}.`,
    data: { testId, keep, how },
    alert: how === "auto",
  });
  return true;
}
