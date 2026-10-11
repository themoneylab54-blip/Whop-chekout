import { db } from "@/lib/db";
import { isForeignCheckoutHost } from "@/lib/checkout-domain-check";
import { isSameSiteRequest } from "@/lib/host-guard";
import { recordIncident } from "@/lib/incidents";
import { log } from "@/lib/log";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { route } from "@/lib/route";

/*
 * The checkout page reporting its payment form missing in the buyer's browser (inlineWatchdog,
 * paymentHealth), with what the page said, kept to its known fields and cut short. A page that never
 * started, its error screen, a form missing for 12 s without a break or never ready after 30 s are
 * the store's "checkout.form_missing" incidents (each journaled, no alert: the store's tile reads
 * them, red from two buyers who didn't pay afterwards); the rest (a page still loading, a slow
 * request, a buyer leaving before the form was ready, the first prepare given up, a page started after
 * its reload) goes to the logs only. Same-origin beacons from the page only (with its Origin); the
 * answer is always empty, even for an unknown session (nothing to learn from it).
 */

const JOURNALED = {
  not_booted: "La page de paiement ne s'est pas lancée chez un client (fichiers non chargés ou en erreur)",
  page_error: "La page de paiement a affiché son écran d'erreur chez un client",
  prepare_stuck: "Formulaire de paiement ni affiché ni en cours de chargement pendant 12 s chez un client (redemandé)",
  form_not_ready: "Le formulaire de carte de Whop n'était toujours pas prêt après 30 s chez un client",
} as const;
const LOGGED = {
  still_loading: "Checkout page still loading 25 s after it opened in the buyer's browser",
  prepare_slow: "Payment form request still on its way after 20 s in the buyer's browser",
  left_without_form: "Buyer left the checkout page before its payment form was ever ready",
  inline_prepare_failed: "The page's first prepare (sent with its HTML) failed or never answered: asked again",
  recovered: "Checkout page started after the watchdog's reload",
} as const;
type Kind = keyof typeof JOURNALED | keyof typeof LOGGED;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Largest report read (a few hundred bytes in practice). */
const MAX_BODY = 8_192;
/** A session id as the app creates them (cuid). */
const SESSION_ID = /^[a-z0-9]{20,40}$/;

const text = (v: unknown, max = 160) => (typeof v === "string" ? v.slice(0, max) : undefined);
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 0), 3_600_000) : undefined);
const flag = (v: unknown) => (typeof v === "boolean" ? v : undefined);
/** A short list of small records: its known fields only (strings cut short, numbers bounded). */
const records = (v: unknown, fields: readonly string[]) =>
  Array.isArray(v)
    ? v
        .slice(0, 6)
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
        .map((e) => Object.fromEntries(fields.map((f) => [f, typeof e[f] === "number" ? count(e[f]) : text(e[f])]).filter(([, x]) => x !== undefined)))
    : undefined;

/** What the page said, its known fields only. Null: not a report. Pure (exported for tests). */
export function healthReport(raw: unknown): { kind: Kind; data: Record<string, unknown> } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string" || !(has(JOURNALED, r.kind) || has(LOGGED, r.kind))) return null;
  const data: Record<string, unknown> = {
    what: r.kind,
    t: count(r.t),
    state: text(r.state, 20),
    visible: text(r.visible, 20),
    online: flag(r.online),
    afterReload: r.afterReload === null ? null : flag(r.afterReload),
    reloading: flag(r.reloading),
    typed: flag(r.typed),
    dpl: text(r.dpl, 64),
    errors: records(r.errors, ["res", "msg", "at"]),
    dropped: count(r.dropped),
    failed: records(r.failed, ["res", "status"]),
    provider: text(r.provider, 20),
    prepared: flag(r.prepared),
    preparing: flag(r.preparing),
    quote: flag(r.quote),
    paypal: flag(r.paypal),
    waitedMs: count(r.waitedMs),
    frame: flag(r.frame),
    lastState: text(r.lastState, 20),
    reason: text(r.reason, 20),
    msg: text(r.msg, 200),
    digest: text(r.digest, 40),
  };
  return { kind: r.kind as Kind, data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) };
}

const empty = () => new Response(null, { status: 204 });

async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // The checkout page's own beacon: same origin, with its Origin (a browser always sends it here).
  if (!req.headers.get("origin") || !isSameSiteRequest(req)) return new Response(null, { status: 403 });
  if (!SESSION_ID.test(id)) return new Response(null, { status: 404 });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return new Response(null, { status: 413 });
  if (!(await rateLimit(`health:ip:${clientIp(req)}`, 20))) return new Response(null, { status: 429 });
  const body = await req.text().catch(() => "");
  if (body.length > MAX_BODY) return new Response(null, { status: 413 });
  let raw: unknown = null;
  try {
    raw = JSON.parse(body);
  } catch {
    /* not JSON: not a report */
  }
  const report = healthReport(raw);
  if (!report) return new Response(null, { status: 400 });
  // A few reports per session (a page reporting each of its steps), never a flood.
  if (!(await rateLimit(`health:s:${id}`, 5, 10 * 60_000))) return empty();
  const session = await db.checkoutSession.findUnique({ where: { id }, select: { storeId: true, store: { select: { id: true, checkoutDomain: true } } } });
  if (!session || (await isForeignCheckoutHost(req, session.store))) return empty();
  const data = { ...report.data, ua: text(req.headers.get("user-agent"), 200) };
  if (has(LOGGED, report.kind)) {
    log.warn(`checkout.health.${report.kind}`, LOGGED[report.kind as keyof typeof LOGGED], { storeId: session.storeId, sessionId: id, ...data });
    return empty();
  }
  // The watchdog's one reload: done with this report, already done (this load came after it), or
  // none (the buyer's storage blocked: no way to do it only once).
  const reload = report.data.reloading === true ? " : page rechargée automatiquement" : report.data.afterReload === true ? " : encore après le rechargement automatique" : "";
  const message = `${JOURNALED[report.kind as keyof typeof JOURNALED]}${report.kind === "not_booted" ? reload : ""}.`;
  // Every report journaled (the tile counts buyers; this route's own limits bound the rows).
  await recordIncident({ storeId: session.storeId, sessionId: id, kind: "checkout.form_missing", message, data, alert: false, everyMs: 1_000 });
  return empty();
}

export const POST = route("sessions.health", handle);
