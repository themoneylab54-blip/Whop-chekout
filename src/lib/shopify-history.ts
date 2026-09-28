import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { log } from "./log";
import { DeadlineError, notePartial, stopForTime } from "./deadline";
import { recordIncident } from "./incidents";
import { shopifyGraphql, type OrderCustomer } from "./shopify";
import { vatRate } from "./vat";
import { tzOf, zonedDay } from "./time";

/*
 * What the Shopify store knows beyond this app's own orders, for analytics:
 *  - the buyers' order history (ShopifyCustomer): backfilled once when a store connects (customers
 *    with at least one order: e-mail, order count, oldest order), then kept current by every order
 *    this app creates (orderCreate returns the customer) — new vs returning counts a buyer who
 *    already ordered through Shopify's own checkout as returning;
 *  - the orders placed outside this checkout (ExternalOrder, "hors checkout Whop": native checkout
 *    during a fallback or for buyers the loader didn't catch, POS, draft orders…), imported daily
 *    from the tick for the leakage indicator (revenue only, no costs).
 * Both run in the background tick, bounded by its deadline, resuming from a saved cursor. Shopify
 * only shows apps the last 60 days of orders without the read_all_orders scope: the first external
 * import starts 60 days back, and a customer's oldest visible order may be recent (their order count
 * still says they ordered before).
 */

/**
 * One Shopify call (2 attempts × 12 s, plus the backoff between them) must fit before the run's hard
 * deadline to start a page. Each attempt is also bounded on its own (shopifyGraphql refuses to start
 * one that couldn't finish: DeadlineError, resumed next run).
 */
export const CALL_RESERVE_MS = 25_000;
/** A background import failing for this long raises an incident (daily) and degrades health. */
export const IMPORT_ERROR_INCIDENT_MS = 48 * 3600_000;
const PAGE = 100;
const CUSTOMERS_PAGE = 50;
const MAX_PAGES_PER_STORE = 5;
const EXTERNAL_EVERY_MS = 24 * 3600_000;
/** First external import: Shopify's default order visibility for apps. */
export const EXTERNAL_FIRST_DAYS = 60;
/** Each daily import re-reads the orders updated since a little before the last run (edits, refunds). */
const EXTERNAL_OVERLAP_MS = 3600_000;
/** Our own orders (checkout, offers, replacements) carry this tag and source name. */
const OWN_TAG = "whop-checkout";

const customersKey = (storeId: string) => `shopify-customers:${storeId}`;
const externalKey = (storeId: string) => `external-orders:${storeId}`;

export type CustomersBackfill = {
  state: "running" | "done" | "error";
  cursor: string | null;
  customers: number;
  startedAt: string;
  doneAt?: string;
  error?: string;
  /** First failure of the current error streak (cleared by a success). */
  errorSince?: string;
  /** Shopify connection the backfill belongs to (a reconnection starts over). */
  connectedAt: string | null;
};

export type ExternalImport = {
  /** Orders updated since this instant are (re)read by the current / next run. */
  since: string;
  /** Pagination cursor of a run cut by the deadline. */
  after: string | null;
  runStartedAt: string | null;
  lastRunAt: string | null;
  imported: number;
  /** Orders are known from this instant on (60 days before the first import). */
  coveredFrom?: string;
  /** Start of the last run that completed (every order placed before it is imported), kept through later failures. */
  coveredUntil?: string;
  /** End of the last run that completed (display: "Dernier import complet"). */
  lastCompletedAt?: string;
  error?: string;
  /** First failure of the current error streak (cleared by a success). */
  errorSince?: string;
};

async function readJson<T>(key: string): Promise<T | null> {
  const row = await db.appSetting.findUnique({ where: { key } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown) {
  const v = JSON.stringify(value);
  await db.appSetting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
}

export const customersBackfillStatus = (storeId: string) => readJson<CustomersBackfill>(customersKey(storeId));
export const externalImportStatus = (storeId: string) => readJson<ExternalImport>(externalKey(storeId));

/**
 * Until when the outside orders are known for sure: the start of the last import run that completed
 * (orders placed before it are in ExternalOrder) — still true while a later run fails or is mid-run, so a
 * failed run never extends it. Older statuses (no `coveredUntil`): the current run's start when it completed
 * without error, else null. Null: never completed. Pure.
 */
export function externalCoveredUntil(st: ExternalImport | null | undefined): number | null {
  if (st?.coveredUntil) {
    const t = Date.parse(st.coveredUntil);
    return Number.isFinite(t) ? t : null;
  }
  if (!st || st.after || st.error || !st.lastRunAt || !st.runStartedAt) return null;
  const t = Date.parse(st.runStartedAt);
  return Number.isFinite(t) ? t : null;
}

/** When the last import run completed (ISO), for display; older statuses: their last run when it completed. Pure. */
export function externalLastCompletedAt(st: ExternalImport | null | undefined): string | null {
  if (!st) return null;
  if (st.lastCompletedAt) return st.lastCompletedAt;
  return !st.coveredUntil && externalCoveredUntil(st) != null ? st.lastRunAt : null;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/* ------------------------------------------------------------------ */
/* Buyer history                                                        */
/* ------------------------------------------------------------------ */

/**
 * Orders the buyer had placed on the Shopify store before `orderId`, from orderCreate's customer:
 * lifetime count minus this order; at least 1 when their oldest order isn't this one (the count
 * can lag behind the new order). Null when Shopify returned no customer. Pure.
 */
export function priorOrdersOf(customer: OrderCustomer | null | undefined, orderId: string): number | null {
  if (!customer) return null;
  const count = Number(customer.numberOfOrders);
  const oldest = customer.orders?.nodes?.[0];
  const olderExists = !!oldest && oldest.id !== orderId;
  if (!Number.isFinite(count)) return olderExists ? 1 : null;
  return olderExists ? Math.max(1, count - 1) : Math.max(0, count - 1);
}

/** Upserts buyers' histories: order count (highest seen) and oldest known order (earliest seen). */
async function saveCustomers(storeId: string, rows: { email: string; customerId: string | null; numberOfOrders: number; firstOrderAt: Date }[]) {
  const ops = rows.map(
    (r) => db.$executeRaw`
      INSERT INTO "ShopifyCustomer" ("id", "storeId", "email", "shopifyCustomerId", "firstOrderAt", "numberOfOrders", "updatedAt")
      VALUES (${randomUUID()}, ${storeId}, ${r.email}, ${r.customerId}, ${r.firstOrderAt}, ${r.numberOfOrders}, now())
      ON CONFLICT ("storeId", "email") DO UPDATE SET
        "shopifyCustomerId" = COALESCE(EXCLUDED."shopifyCustomerId", "ShopifyCustomer"."shopifyCustomerId"),
        "firstOrderAt" = LEAST(COALESCE("ShopifyCustomer"."firstOrderAt", EXCLUDED."firstOrderAt"), EXCLUDED."firstOrderAt"),
        "numberOfOrders" = GREATEST("ShopifyCustomer"."numberOfOrders", EXCLUDED."numberOfOrders"),
        "updatedAt" = now()`,
  );
  for (let i = 0; i < ops.length; i += 100) await db.$transaction(ops.slice(i, i + 100));
}

/**
 * After this app created a buyer's order: records how many orders they had before on the Shopify
 * store (CheckoutSession.shopifyPriorOrders) and their history. Never throws (analytics only).
 */
export async function recordOrderCustomer(session: { id: string; storeId: string; email: string | null }, order: { id: string; customer?: OrderCustomer | null }): Promise<void> {
  try {
    const prior = priorOrdersOf(order.customer, order.id);
    if (prior == null) return;
    await db.checkoutSession.update({ where: { id: session.id }, data: { shopifyPriorOrders: prior } });
    const email = session.email?.trim().toLowerCase();
    const nodes = order.customer?.orders?.nodes ?? [];
    const oldest = nodes[0]?.createdAt;
    if (email && oldest && !Number.isNaN(Date.parse(oldest))) {
      const count = Math.max(prior + 1, Number(order.customer!.numberOfOrders) || 0);
      await saveCustomers(session.storeId, [{ email, customerId: order.customer!.id ?? null, numberOfOrders: count, firstOrderAt: firstOrderAtOf(count, nodes, new Date()) }]);
    }
  } catch (err) {
    log.warn("shopify.customer_history_failed", "Could not record the buyer's Shopify history", { sessionId: session.id, err });
  }
}

type CustomerNode = {
  id: string;
  numberOfOrders: string | number | null;
  defaultEmailAddress?: { emailAddress?: string | null } | null;
  orders?: { nodes: { createdAt: string }[] } | null;
};

/** Orders an app sees without the read_all_orders scope (Shopify's default): the last 60 days. */
export const ORDER_VISIBILITY_DAYS = 60;
/** Oldest orders read per customer (sorted by creation): enough to tell hidden orders apart. */
export const VISIBLE_ORDERS_SAMPLE = 10;

/**
 * Date of a customer's first order on the store from their lifetime order count and their oldest
 * visible orders (sorted by creation, at most VISIBLE_ORDERS_SAMPLE). When the count exceeds the
 * orders the app can see and the oldest visible one is inside the visibility window, older orders are
 * hidden: the first order is before the window (its start less a day), never the oldest visible one.
 * Pure.
 */
export function firstOrderAtOf(numberOfOrders: number, visible: { createdAt: string }[], seenAt: Date): Date {
  const times = visible.map((n) => Date.parse(n.createdAt)).filter((t) => Number.isFinite(t));
  const oldest = times.length ? Math.min(...times) : null;
  const windowStart = seenAt.getTime() - ORDER_VISIBILITY_DAYS * 86_400_000;
  const hidden = numberOfOrders > times.length && (oldest == null || oldest >= windowStart);
  if (hidden) return new Date(Math.min(oldest ?? Infinity, windowStart - 86_400_000));
  return new Date(Math.min(oldest ?? seenAt.getTime(), seenAt.getTime()));
}

/** Customers page → rows to save (with an e-mail and at least one order). Pure. */
export function customerRows(nodes: CustomerNode[], seenAt: Date): { email: string; customerId: string; numberOfOrders: number; firstOrderAt: Date }[] {
  const out: { email: string; customerId: string; numberOfOrders: number; firstOrderAt: Date }[] = [];
  for (const c of nodes) {
    const email = c.defaultEmailAddress?.emailAddress?.trim().toLowerCase();
    const count = Number(c.numberOfOrders);
    if (!email || !Number.isFinite(count) || count <= 0) continue;
    out.push({ email, customerId: c.id, numberOfOrders: count, firstOrderAt: firstOrderAtOf(count, c.orders?.nodes ?? [], seenAt) });
  }
  return out;
}

const CUSTOMERS_QUERY = `query($first: Int!, $after: String) {
  customers(first: $first, after: $after, sortKey: ID, query: "orders_count:>0") {
    pageInfo { hasNextPage endCursor }
    nodes { id numberOfOrders defaultEmailAddress { emailAddress } orders(first: ${VISIBLE_ORDERS_SAMPLE}, sortKey: CREATED_AT) { nodes { createdAt } } }
  }
}`;

type Connected = { id: string; shopDomain: string | null; shopifyAccessToken: string | null; shopifyConnectedAt: Date | null };

/** One-time backfill of the buyers' Shopify history, a few pages per store per run. Returns the customers saved. */
export async function backfillShopifyCustomers(deadline: number, opts: { storeId?: string } = {}): Promise<number> {
  const stores: Connected[] = await db.store.findMany({
    where: { ...(opts.storeId ? { id: opts.storeId } : {}), shopDomain: { not: null }, shopifyAccessToken: { not: null }, shopifyConnectedAt: { not: null } },
    select: { id: true, shopDomain: true, shopifyAccessToken: true, shopifyConnectedAt: true },
  });
  let saved = 0;
  for (const store of stores) {
    if (stopForTime(deadline, CALL_RESERVE_MS)) break;
    const connectedAt = store.shopifyConnectedAt?.toISOString() ?? null;
    let st = await customersBackfillStatus(store.id);
    if (st && st.connectedAt !== connectedAt) st = null;
    if (st?.state === "done") continue;
    // An error is retried on the next day's runs (not every tick).
    if (st?.state === "error" && Date.now() - Date.parse(st.doneAt ?? st.startedAt) < EXTERNAL_EVERY_MS) continue;
    const state: CustomersBackfill =
      st && st.state === "running"
        ? st
        : { state: "running", cursor: st?.cursor ?? null, customers: st?.customers ?? 0, startedAt: new Date().toISOString(), connectedAt, ...(st?.errorSince ? { errorSince: st.errorSince } : {}) };
    try {
      for (let page = 0; page < MAX_PAGES_PER_STORE; page++) {
        if (stopForTime(deadline, CALL_RESERVE_MS)) break;
        const data = await shopifyGraphql<{ customers: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: CustomerNode[] } }>(store, CUSTOMERS_QUERY, {
          // 50 customers × 10 orders keeps the query's cost under Shopify's 1 000 points.
          first: CUSTOMERS_PAGE,
          after: state.cursor,
        });
        const rows = customerRows(data.customers?.nodes ?? [], new Date());
        await saveCustomers(store.id, rows);
        saved += rows.length;
        state.customers += rows.length;
        state.cursor = data.customers?.pageInfo?.endCursor ?? state.cursor;
        // A page read: Shopify answers again (an error streak is over).
        delete state.errorSince;
        if (!data.customers?.pageInfo?.hasNextPage) {
          state.state = "done";
          state.doneAt = new Date().toISOString();
          delete state.error;
          break;
        }
      }
    } catch (err) {
      if (err instanceof DeadlineError) notePartial();
      else {
        state.state = "error";
        state.error = errorText(err);
        state.doneAt = new Date().toISOString();
        state.errorSince ??= state.doneAt;
        log.warn("shopify.customers_backfill_failed", "Shopify customers backfill failed", { storeId: store.id, err });
      }
    }
    await writeJson(customersKey(store.id), state);
    await reportStuckImport(store.id, "customers", state);
  }
  return saved;
}

/* ------------------------------------------------------------------ */
/* Orders outside this checkout                                        */
/* ------------------------------------------------------------------ */

type OrderNode = {
  id: string;
  name: string;
  processedAt?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  test?: boolean | null;
  cancelledAt?: string | null;
  sourceName?: string | null;
  tags?: string[] | null;
  discountCodes?: string[] | null;
  currentTotalPriceSet?: { shopMoney?: { amount?: string | number | null; currencyCode?: string | null } | null } | null;
  shippingAddress?: { countryCodeV2?: string | null } | null;
};

/** Whether a Shopify order was created by this app (checkout, offer or replacement order). Pure. */
export function isOwnOrder(o: Pick<OrderNode, "sourceName" | "tags">): boolean {
  return o.sourceName === OWN_TAG || !!o.tags?.includes(OWN_TAG);
}

/** Orders page → ExternalOrder rows (our own orders left out). HT with the store's VAT model (standard rates). Pure. */
export function externalRows(nodes: OrderNode[], store: { shopCurrency: string; vatExempt: boolean; vatDomesticOnly: boolean; homeCountry?: string | null }) {
  return nodes
    .filter((o) => o?.id && !isOwnOrder(o))
    .map((o) => {
      const amount = Number(o.currentTotalPriceSet?.shopMoney?.amount ?? 0);
      const totalCents = Number.isFinite(amount) ? Math.round(amount * 100) : 0;
      const countryCode = o.shippingAddress?.countryCodeV2?.toUpperCase() ?? null;
      const rate = vatRate(countryCode, { vatExempt: store.vatExempt, domesticOnly: store.vatDomesticOnly, homeCountry: store.homeCountry || undefined });
      return {
        shopifyOrderId: o.id,
        name: String(o.name ?? o.id).slice(0, 100),
        orderedAt: new Date(o.processedAt ?? o.createdAt),
        currency: (o.currentTotalPriceSet?.shopMoney?.currencyCode ?? store.shopCurrency).toUpperCase(),
        totalCents,
        htCents: Math.round(totalCents / (1 + rate)),
        countryCode,
        sourceName: o.sourceName?.slice(0, 100) ?? null,
        test: !!o.test,
        cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
        // Codes used outside this checkout: Shopify's code usage calibration must see them.
        discountCodes: [...new Set((o.discountCodes ?? []).filter((c): c is string => typeof c === "string" && !!c.trim()).map((c) => c.trim().toUpperCase().slice(0, 100)))].slice(0, 20),
      };
    });
}

const ORDERS_QUERY = `query($first: Int!, $after: String, $q: String!) {
  orders(first: $first, after: $after, sortKey: UPDATED_AT, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes { id name processedAt createdAt updatedAt test cancelledAt sourceName tags discountCodes currentTotalPriceSet { shopMoney { amount currencyCode } } shippingAddress { countryCodeV2 } }
  }
}`;

/**
 * Whether the daily outside-orders import is due: never ran, ran 24 h ago or more, or — so that the
 * daily report (07:00) sees a complete yesterday — a new local day started since the last run (the
 * first tick after the store's midnight imports again). Pure.
 */
export function externalImportDue(lastRunAt: string | null, now: Date, tz: string): boolean {
  if (!lastRunAt) return true;
  const last = new Date(lastRunAt);
  if (!Number.isFinite(last.getTime())) return true;
  return now.getTime() - last.getTime() >= EXTERNAL_EVERY_MS || zonedDay(last, tz) < zonedDay(now, tz);
}

/**
 * Daily import of the Shopify orders not created by this app (updated since the last run, so edits,
 * refunds and cancellations land too). A run cut by the deadline resumes from its cursor on the next
 * tick. Returns the orders written.
 */
export async function importExternalOrders(deadline: number, opts: { storeId?: string; force?: boolean } = {}): Promise<number> {
  const stores = await db.store.findMany({
    where: { ...(opts.storeId ? { id: opts.storeId } : {}), shopDomain: { not: null }, shopifyAccessToken: { not: null }, shopifyConnectedAt: { not: null } },
    select: { id: true, shopDomain: true, shopifyAccessToken: true, shopCurrency: true, vatExempt: true, vatDomesticOnly: true, homeCountry: true, timezone: true },
  });
  let written = 0;
  for (const store of stores) {
    if (stopForTime(deadline, CALL_RESERVE_MS)) break;
    const prev = await externalImportStatus(store.id);
    const midRun = !!prev?.after;
    if (!opts.force && !midRun && !externalImportDue(prev?.lastRunAt ?? null, new Date(), tzOf(store))) continue;
    const state: ExternalImport = {
      since: prev?.since ?? new Date(Date.now() - EXTERNAL_FIRST_DAYS * 86_400_000).toISOString(),
      after: midRun ? prev!.after : null,
      runStartedAt: midRun ? (prev!.runStartedAt ?? new Date().toISOString()) : new Date().toISOString(),
      lastRunAt: prev?.lastRunAt ?? null,
      imported: prev?.imported ?? 0,
      ...(prev?.errorSince ? { errorSince: prev.errorSince } : {}),
      ...(prev?.error ? { error: prev.error } : {}),
      // Coverage of the last completed run survives this one (failing or cut short); older statuses: their
      // own completed run, if it completed.
      ...(prev && externalCoveredUntil(prev) != null ? { coveredUntil: new Date(externalCoveredUntil(prev)!).toISOString() } : {}),
      ...(externalLastCompletedAt(prev) ? { lastCompletedAt: externalLastCompletedAt(prev)! } : {}),
    };
    state.coveredFrom = prev?.coveredFrom ?? state.since;
    const q = `updated_at:>='${state.since}' -tag:${OWN_TAG}`;
    try {
      for (let page = 0; page < MAX_PAGES_PER_STORE; page++) {
        if (stopForTime(deadline, CALL_RESERVE_MS)) break;
        const data = await shopifyGraphql<{ orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: OrderNode[] } }>(store, ORDERS_QUERY, {
          first: PAGE,
          after: state.after,
          q,
        });
        const rows = externalRows(data.orders?.nodes ?? [], store);
        const ops = rows.map((r) =>
          db.externalOrder.upsert({
            where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId: r.shopifyOrderId } },
            create: { storeId: store.id, ...r },
            update: r,
          }),
        );
        for (let i = 0; i < ops.length; i += 100) await db.$transaction(ops.slice(i, i + 100));
        written += rows.length;
        state.imported += rows.length;
        if (data.orders?.pageInfo?.hasNextPage && data.orders.pageInfo.endCursor) {
          state.after = data.orders.pageInfo.endCursor;
          continue;
        }
        // Run complete: the next one re-reads from a little before this one started.
        state.after = null;
        state.since = new Date(Date.parse(state.runStartedAt!) - EXTERNAL_OVERLAP_MS).toISOString();
        state.lastRunAt = new Date().toISOString();
        state.coveredUntil = state.runStartedAt!;
        state.lastCompletedAt = state.lastRunAt;
        delete state.error;
        delete state.errorSince;
        break;
      }
      // Pages left (page cap or time budget): resumed from the cursor next run.
      if (state.after) notePartial();
    } catch (err) {
      if (err instanceof DeadlineError) notePartial();
      else {
        // Retried on the next daily run, from the same point.
        state.after = null;
        state.lastRunAt = new Date().toISOString();
        state.error = errorText(err);
        state.errorSince ??= state.lastRunAt;
        log.warn("shopify.external_orders_failed", "Shopify external orders import failed", { storeId: store.id, err });
      }
    }
    await writeJson(externalKey(store.id), state);
    await reportStuckImport(store.id, "external", state);
  }
  return written;
}

/* ------------------------------------------------------------------ */
/* Imports failing for days                                             */
/* ------------------------------------------------------------------ */

export type BackgroundImport = "customers" | "external" | "adspend";

const IMPORT_LABEL: Record<BackgroundImport, string> = {
  customers: "l'import de l'historique des clients Shopify (nouveaux / récurrents)",
  external: "l'import des commandes Shopify hors checkout (ventes hors checkout Whop)",
  adspend: "l'import de l'historique des dépenses publicitaires (13 mois)",
};

/** Shopify refused access to customer data (Protected Customer Data not approved for the app). Pure. */
export function customerAccessDenied(error: string | null | undefined): boolean {
  if (!error) return false;
  return /customer/i.test(error) && /(access denied|not approved|protected customer|ACCESS_DENIED|not authorized|unauthorized|permission)/i.test(error);
}

/** Merchant-facing line of an import failing since `since` (Protected Customer Data hint when relevant). Pure. */
export function stuckImportMessage(what: BackgroundImport, error: string, since: string): string {
  const days = Math.max(2, Math.floor((Date.now() - Date.parse(since)) / 86_400_000));
  const pcd = customerAccessDenied(error)
    ? " Shopify refuse l'accès aux données clients : demandez l'accès « Protected Customer Data » (niveau 1 : nom, e-mail) pour l'application dans le Partner Dashboard / les paramètres de l'app personnalisée, puis reconnectez Shopify."
    : "";
  return `Échec de ${IMPORT_LABEL[what]} depuis ${days} jours (${error.slice(0, 200)}) : les chiffres qui en dépendent sont incomplets. Nouvel essai automatique chaque jour.${pcd}`;
}

/**
 * An import in error for more than IMPORT_ERROR_INCIDENT_MS: an incident (journal + alert, at most once
 * a day per store) — failing silently for days would leave analytics incomplete. Never throws.
 */
export async function reportStuckImport(storeId: string, what: BackgroundImport, state: { error?: string; errorSince?: string } | null | undefined): Promise<boolean> {
  if (!state?.error || !state.errorSince || Date.now() - Date.parse(state.errorSince) < IMPORT_ERROR_INCIDENT_MS) return false;
  await recordIncident({
    storeId,
    kind: "import.background_failed",
    message: stuckImportMessage(what, state.error, state.errorSince),
    data: { what, err: state.error, since: state.errorSince, protectedCustomerData: customerAccessDenied(state.error) },
    everyMs: 24 * 3600_000,
  });
  return true;
}

/** Imports of a store failing for more than 48 h (health tile and probe). */
export async function stuckImports(storeId: string): Promise<{ what: BackgroundImport; error: string; since: string }[]> {
  const [customers, external, adspend] = await Promise.all([
    customersBackfillStatus(storeId),
    externalImportStatus(storeId),
    db.appSetting.findUnique({ where: { key: `adspend-backfill:${storeId}` } }),
  ]);
  const out: { what: BackgroundImport; error: string; since: string }[] = [];
  const old = (since?: string) => !!since && Date.now() - Date.parse(since) >= IMPORT_ERROR_INCIDENT_MS;
  if (customers?.error && customers.state === "error" && old(customers.errorSince)) out.push({ what: "customers", error: customers.error, since: customers.errorSince! });
  if (external?.error && old(external.errorSince)) out.push({ what: "external", error: external.error, since: external.errorSince! });
  try {
    const st = adspend ? (JSON.parse(adspend.value) as { platforms?: Record<string, { error?: string; errorSince?: string }> }) : null;
    for (const p of Object.values(st?.platforms ?? {})) {
      if (p?.error && old(p.errorSince)) {
        out.push({ what: "adspend", error: p.error, since: p.errorSince! });
        break;
      }
    }
  } catch {
    /* unreadable state: nothing to report */
  }
  return out;
}

/** Tick job: the buyers' history backfill, then the daily import of outside orders. */
export async function shopifyHistoryUpkeep(deadline: number): Promise<number> {
  const customers = await backfillShopifyCustomers(deadline);
  return customers + (await importExternalOrders(deadline));
}

/**
 * SQL filter (on ExternalOrder aliased `e`): real outside orders — not cancelled, not a test (unless
 * asked), and not one of ours linked by hand (an order the merchant created and linked to a checkout,
 * an offer order or a replacement).
 */
export function externalScope(storeId: string, includeTest: boolean): Prisma.Sql {
  return Prisma.sql`e."storeId" = ${storeId} AND e."cancelledAt" IS NULL ${includeTest ? Prisma.empty : Prisma.sql`AND e."test" = false`}
    AND NOT EXISTS (SELECT 1 FROM "CheckoutSession" cs WHERE cs."storeId" = ${storeId} AND cs."shopifyOrderId" = e."shopifyOrderId")
    AND NOT EXISTS (SELECT 1 FROM "UpsellCharge" uc JOIN "CheckoutSession" cs ON cs.id = uc."sessionId" WHERE cs."storeId" = ${storeId} AND uc."shopifyOrderId" = e."shopifyOrderId")
    AND NOT EXISTS (SELECT 1 FROM "ProtectionClaim" pc WHERE pc."storeId" = ${storeId} AND pc."replacementOrderId" = e."shopifyOrderId")`;
}
