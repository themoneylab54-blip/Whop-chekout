import "server-only";
import type { Store } from "@prisma/client";
import { db } from "./db";
import { env } from "./env";
import { log, recordEvent } from "./log";
import { registerApplePayDomain, unregisterApplePayDomain } from "./whop";
import { registerStripeDomain } from "./stripe";
import { stripeConfigured, stripeModeOf } from "./stripe-config";
import { removeProjectDomain, vercelConfig, vercelDomainProblem } from "./vercel-domains";
import { appExtraHosts, hostnameOf, isAppHost } from "./host-guard";
import {
  DOMAIN_PING_PATH,
  dnsRecordAdvice,
  domainToken,
  formatDomainError,
  humanizePingError,
  isApexDomain,
  parseDomainError,
  TLS_ADD_TO_VERCEL_MESSAGE,
  type DomainErrorKind,
} from "./checkout-domain";

/** The ping must answer within this (merchant waits on the "Vérifier" button; the tick's slice is 5 s). */
export const PING_TIMEOUT_MS = 5_000;
/**
 * Pending domains (and verified ones that failed their last check) are re-checked this often by the
 * tick, healthy verified ones every hour: a domain that dies is noticed within about an hour and
 * un-verified at the next failing run (≥ 10 min later), buyer links then going back to APP_URL.
 */
export const PENDING_RECHECK_MS = 10 * 60_000;
export const VERIFIED_RECHECK_MS = 3600_000;

export type PingResult = { ok: true } | { ok: false; kind: DomainErrorKind; message: string };

/**
 * Fetches https://<domain>/.well-known/whop-checkout-ping and compares it with the store's token:
 * proves the DNS points to this deployment, Vercel serves the domain with a valid certificate and
 * the domain belongs to this store. Never throws.
 */
export async function pingDomain(storeId: string, domain: string, timeoutMs = PING_TIMEOUT_MS): Promise<PingResult> {
  let res: Response;
  try {
    res = await fetch(`https://${domain}${DOMAIN_PING_PATH}`, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "text/plain" } });
  } catch (err) {
    return { ok: false, ...humanizePingError(err, { apex: isApexDomain(domain) }) };
  }
  const body = (await res.text().catch(() => "")).trim();
  if (res.status === 200 && body === domainToken(storeId, domain)) return { ok: true };
  if (res.status === 200 && body.startsWith("whopco-")) {
    return { ok: false, kind: "mismatch", message: "Le domaine répond, mais depuis un autre déploiement du checkout : vérifiez qu'il est ajouté au bon projet Vercel." };
  }
  if (res.status === 404 && /DEPLOYMENT_NOT_FOUND|deployment could not be found|DNS_HOSTNAME/i.test(body)) {
    return { ok: false, kind: "mismatch", message: "Le domaine pointe bien vers Vercel mais n'est pas ajouté à ce projet : ajoutez-le dans Vercel → Settings → Domains." };
  }
  return {
    ok: false,
    kind: "mismatch",
    message: `Le domaine répond (HTTP ${res.status}) mais pas avec ce checkout : vérifiez ${dnsRecordAdvice(isApexDomain(domain))} et que le domaine est ajouté dans Vercel.`,
  };
}

export type DomainCheckResult = { verified: boolean; message: string | null; domain: string | null };

/**
 * Checks the store's checkout domain and records the result. First success: journal + Apple Pay
 * domain registered with Whop. A verified domain that stops answering stays verified after a first
 * failed check (recorded in checkoutDomainError: one blip, a slow cold start, must not move buyers);
 * the next failed check (a later tick run, ≥ 10 min after) un-verifies it — buyer links go back to
 * APP_URL, never to a dead domain — and the merchant is alerted.
 */
export async function checkStoreDomain(
  storeId: string,
  opts: {
    retry?: boolean;
    now?: Date;
    timeoutMs?: number;
    vercel?: boolean;
    /**
     * The tick's second chance for a timeout (a cold start, a slow edge): one more ping, with a longer
     * timeout, after a short pause, if it can start before `deadline`. A verified domain whose timeout
     * can't be retried in time is left as is (the next run checks it again): no strike on one slow answer.
     */
    timeoutRetry?: { deadline: number; delayMs?: number; timeoutMs?: number };
  } = {},
): Promise<DomainCheckResult> {
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store?.checkoutDomain) return { verified: false, message: null, domain: null };
  const domain = store.checkoutDomain;
  let result = await pingDomain(store.id, domain, opts.timeoutMs);
  if (!result.ok && opts.retry) result = await pingDomain(store.id, domain, opts.timeoutMs);
  if (!result.ok && result.kind === "timeout" && opts.timeoutRetry) {
    const { deadline, delayMs = TICK_RETRY_DELAY_MS, timeoutMs = TICK_RETRY_TIMEOUT_MS } = opts.timeoutRetry;
    if (Date.now() + delayMs < deadline) {
      await new Promise((r) => setTimeout(r, delayMs));
      result = await pingDomain(store.id, domain, timeoutMs);
    } else if (store.checkoutDomainVerifiedAt) {
      log.info("checkout_domain.check_deferred", "Checkout domain timed out with no time left to retry; checked again next run", { storeId: store.id, domain });
      return { verified: true, message: null, domain };
    }
  }
  const now = opts.now ?? new Date();
  if (result.ok) {
    const saved = await db.store.updateMany({
      where: { id: store.id, checkoutDomain: domain },
      data: { checkoutDomainVerifiedAt: now, checkoutDomainError: null, checkoutDomainCheckedAt: now, checkoutDomainPendingSince: null },
    });
    // The domain changed during the check: this result is about a domain the store no longer uses.
    if (!saved.count) return { verified: false, message: null, domain: null };
    if (!store.checkoutDomainVerifiedAt) await onVerified(store, domain, now);
    return { verified: true, message: null, domain };
  }
  // The Vercel side says more about a failure when the API is configured (ownership TXT, DNS not seen,
  // domain missing from the project — also behind a certificate error: Vercel only issues it once the
  // domain is on the project). Without the API, a certificate error is usually that very step.
  const hasVercel = vercelConfig() !== null;
  const cfg = opts.vercel === false ? null : vercelConfig();
  const vercel = cfg ? await vercelDomainProblem(cfg, domain, { apex: isApexDomain(domain) }) : null;
  const kind: DomainErrorKind = vercel && /TXT|n'est pas \(ou plus\) ajouté/.test(vercel) ? "vercel" : result.kind;
  const message = vercel && kind === "vercel" ? vercel : result.kind === "tls" && !hasVercel ? TLS_ADD_TO_VERCEL_MESSAGE : result.message;
  // First failure of a verified domain: recorded, the domain stays in use until the next failed check.
  const firstStrike = !!store.checkoutDomainVerifiedAt && !parseDomainError(store.checkoutDomainError);
  // A failure less than PENDING_RECHECK_MS after the previous (failed) one — "Vérifier" clicked twice
  // during a short outage — doesn't count as the second strike, nor move the time of the first one
  // (the tick's next run still makes that second check on time).
  const tooSoon =
    !firstStrike && !!store.checkoutDomainVerifiedAt && !!store.checkoutDomainCheckedAt && now.getTime() - store.checkoutDomainCheckedAt.getTime() < PENDING_RECHECK_MS;
  const keep = firstStrike || tooSoon;
  const saved = await db.store.updateMany({
    where: { id: store.id, checkoutDomain: domain },
    data: {
      checkoutDomainVerifiedAt: keep ? store.checkoutDomainVerifiedAt : null,
      checkoutDomainError: formatDomainError(kind, message),
      checkoutDomainCheckedAt: tooSoon ? store.checkoutDomainCheckedAt : now,
      // Just lost: pending again from now (re-checked every 10 min before any back-off, see recheckDueDomains).
      ...(!keep && store.checkoutDomainVerifiedAt ? { checkoutDomainPendingSince: now } : {}),
    },
  });
  // The domain changed during the check: no alert about a domain the store no longer uses.
  if (!saved.count) return { verified: false, message: null, domain: null };
  if (tooSoon) return { verified: true, message, domain };
  if (firstStrike) {
    log.warn("checkout_domain.unreachable", "Verified checkout domain failed a check; un-verified if the next one fails", { storeId: store.id, domain, kind });
    return { verified: true, message, domain };
  }
  if (store.checkoutDomainVerifiedAt) {
    await recordEvent({
      storeId: store.id,
      level: "error",
      kind: "checkout_domain.lost",
      message: `Le domaine du checkout ${domain} ne répond plus (${message}) Vos clients paient de nouveau sur ${new URL(env.appUrl).hostname} en attendant ; il sera réactivé tout seul dès qu'il répondra.`,
      alert: true,
    });
  }
  return { verified: false, message, domain };
}

/** A domain verified again within this long of its last "vérifié" entry is a flap, not news. */
export const REVERIFIED_QUIET_MS = 24 * 3600_000;

/**
 * First verification of the domain: journal + Apple Pay registration. Back after a short loss (it was
 * verified — journaled, registered with Whop — less than 24 h ago): only logged, the merchant's
 * journal and Whop's Apple Pay domains are not touched again for a flap.
 */
async function onVerified(store: Store, domain: string, now: Date) {
  const message = `Domaine du checkout vérifié : vos clients paient désormais sur https://${domain}.`;
  const recent = await db.eventLog.findFirst({
    where: { storeId: store.id, kind: "checkout_domain.verified", message, createdAt: { gte: new Date(now.getTime() - REVERIFIED_QUIET_MS) } },
    select: { id: true },
  });
  if (recent) {
    log.info("checkout_domain.reverified", "Checkout domain answers again (verified less than 24 h ago)", { storeId: store.id, domain });
    return;
  }
  await recordEvent({ storeId: store.id, kind: "checkout_domain.verified", message });
  await registerDomainApplePay(store, domain);
  await registerDomainStripe(store, domain);
}

/**
 * Registers the verified checkout domain on the store's connected Stripe account (Apple Pay / Google
 * Pay in Stripe's Payment Element there), when Stripe is connected and its keys are set. Best effort,
 * journaled; never throws (« Enregistrer les domaines » on the Stripe page retries by hand).
 */
async function registerDomainStripe(store: Store, domain: string) {
  if (!store.stripeAccountId || !store.stripeConnectedAt || !stripeConfigured(stripeModeOf(store))) return;
  try {
    const status = await registerStripeDomain(store, domain);
    await recordEvent({
      storeId: store.id,
      kind: "checkout_domain.stripe_wallets",
      message: status === "active" ? `Apple Pay (Stripe) activé sur ${domain}.` : `${domain} enregistré chez Stripe pour Apple Pay (activation en cours).`,
    });
  } catch (err) {
    await recordEvent({
      storeId: store.id,
      level: "warn",
      kind: "checkout_domain.stripe_wallets_failed",
      message: `Apple Pay : Stripe n'a pas pu enregistrer ${domain} (réessayez depuis la page Stripe › Enregistrer les domaines).`,
      err,
    });
  }
}

/** AppSetting holding Apple's domain-association file (pasted in Connexions › Whop › Apple Pay). */
export const APPLE_PAY_ASSOCIATION_KEY = "apple_pay_domain_association";

/**
 * Registers the verified checkout domain with Whop for Apple Pay (best effort, journaled). Skipped
 * while Whop isn't connected or no Apple association file is installed (Apple could not verify the
 * domain: registering it would only leave a failed domain at Whop).
 */
async function registerDomainApplePay(store: Store, domain: string) {
  if (!store.whopConnectedAt || !store.whopApiKey) return;
  if (!(await db.appSetting.findUnique({ where: { key: APPLE_PAY_ASSOCIATION_KEY }, select: { key: true } }))) return;
  try {
    const d = await registerApplePayDomain(store, domain);
    await recordEvent({
      storeId: store.id,
      kind: "checkout_domain.apple_pay",
      message: d.status === "verified" ? `Apple Pay activé sur ${domain}.` : `${domain} enregistré chez Whop pour Apple Pay (vérification Apple en cours).`,
    });
  } catch (err) {
    await recordEvent({
      storeId: store.id,
      level: "warn",
      kind: "checkout_domain.apple_pay_failed",
      message: `Apple Pay : Whop n'a pas pu enregistrer ${domain} (réessayez depuis Connexions › Whop › Apple Pay).`,
      err,
    });
  }
}

/**
 * Re-registers the store's verified checkout domain for Apple Pay: after Whop is (re)connected (new
 * key or account) and after the Apple association file is saved. Never throws.
 */
export async function reregisterApplePayDomain(storeId: string): Promise<void> {
  try {
    const store = await db.store.findUnique({ where: { id: storeId } });
    if (!store?.checkoutDomain || !store.checkoutDomainVerifiedAt) return;
    await registerDomainApplePay(store, store.checkoutDomain);
  } catch (err) {
    log.warn("checkout_domain.apple_pay_failed", "Apple Pay re-registration failed", { storeId, err });
  }
}

/** A tick ping's timeout: the job's pings run side by side within its 5 s slice (with the DB writes). */
export const TICK_PING_TIMEOUT_MS = 2_500;
/**
 * A tick ping that timed out is tried once more, after this pause, with this longer timeout (a cold
 * start answers late once): only a second timeout counts as a failed check. The retry only starts
 * within the job's slice; like any started item it may finish past it (by the timeout at most).
 */
export const TICK_RETRY_DELAY_MS = 300;
export const TICK_RETRY_TIMEOUT_MS = 4_000;

/**
 * Back-off of domains pending for long (DNS never added, abandoned): hourly after 48 h, daily after
 * 7 days. "Vérifier" in the dashboard still checks at once.
 */
export const PENDING_SLOW_AFTER_MS = 48 * 3600_000;
export const PENDING_DAILY_AFTER_MS = 7 * 24 * 3600_000;
export const PENDING_DAILY_RECHECK_MS = 24 * 3600_000;

/**
 * Tick job (not money): re-checks pending domains (and verified ones that failed their last check)
 * every 10 minutes and healthy verified ones every hour (pending ones back off to hourly after 48 h,
 * daily after 7 days), up to 5 per run, side by side, one ping each — a timeout gets one longer
 * retry in the same run (a verified domain is only un-verified after failing on two separate runs,
 * see checkStoreDomain). Then, with the time left, removes from Vercel the domains retired 48 h ago
 * (buyers' domains first: a slow Vercel API never eats the checks' slice). No Vercel API call for
 * the checks: the dashboard's "Vérifier" gives those details.
 */
export async function recheckCheckoutDomains(deadline: number, now = new Date()): Promise<number> {
  const checked = await recheckDueDomains(deadline, now);
  const removed = Date.now() < deadline ? await removeRetiredDomains(deadline, now) : 0;
  return checked + removed;
}

async function recheckDueDomains(deadline: number, now: Date): Promise<number> {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const stores = await db.store.findMany({
    where: {
      checkoutDomain: { not: null },
      OR: [
        { checkoutDomainCheckedAt: null },
        // Verified: every 10 min after a failed check (the second strike), else hourly.
        { checkoutDomainVerifiedAt: { not: null }, checkoutDomainError: { not: null }, checkoutDomainCheckedAt: { lt: ago(PENDING_RECHECK_MS) } },
        { checkoutDomainVerifiedAt: { not: null }, checkoutDomainCheckedAt: { lt: ago(VERIFIED_RECHECK_MS) } },
        // Pending: every 10 min for 48 h, then hourly, then daily after 7 days.
        {
          checkoutDomainVerifiedAt: null,
          OR: [{ checkoutDomainPendingSince: null }, { checkoutDomainPendingSince: { gte: ago(PENDING_SLOW_AFTER_MS) } }],
          checkoutDomainCheckedAt: { lt: ago(PENDING_RECHECK_MS) },
        },
        {
          checkoutDomainVerifiedAt: null,
          checkoutDomainPendingSince: { lt: ago(PENDING_SLOW_AFTER_MS), gte: ago(PENDING_DAILY_AFTER_MS) },
          checkoutDomainCheckedAt: { lt: ago(VERIFIED_RECHECK_MS) },
        },
        { checkoutDomainVerifiedAt: null, checkoutDomainPendingSince: { lt: ago(PENDING_DAILY_AFTER_MS) }, checkoutDomainCheckedAt: { lt: ago(PENDING_DAILY_RECHECK_MS) } },
      ],
    },
    orderBy: { checkoutDomainCheckedAt: { sort: "asc", nulls: "first" } },
    select: { id: true, checkoutDomainVerifiedAt: true },
    take: 5,
  });
  if (!stores.length || Date.now() >= deadline) return 0;
  const done = await Promise.all(
    stores.map((s) =>
      checkStoreDomain(s.id, { now, timeoutMs: TICK_PING_TIMEOUT_MS, vercel: false, timeoutRetry: { deadline } }).then(
        () => 1,
        (err) => {
          log.warn("checkout_domain.check_failed", "Checkout domain check failed", { storeId: s.id, err });
          return 0;
        },
      ),
    ),
  );
  return done.reduce<number>((a, b) => a + b, 0);
}

/* Retired domains ------------------------------------------------------------ */

/**
 * A checkout domain the store stopped using (changed or removed) stays on the Vercel project this
 * long: links already sent (open checkouts, Whop's return URL to /c/<id>/merci) keep reaching the
 * app, whose /c pages then send the buyer to the store's current host.
 */
export const RETIRED_DOMAIN_GRACE_MS = 48 * 3600_000;
const RETIRED_PREFIX = "checkout-domain:retired:";
type Retired = { storeId: string; removeAt: string };

/** Records `domain` (just left by `storeId`) for removal from Vercel after the grace period. */
export async function retireCheckoutDomain(storeId: string, domain: string, now = new Date()): Promise<void> {
  const value = JSON.stringify({ storeId, removeAt: new Date(now.getTime() + RETIRED_DOMAIN_GRACE_MS).toISOString() } satisfies Retired);
  // updatedAt = the retirement time: removeRetiredDomains selects the due rows on it (removeAt − 48 h).
  await db.appSetting.upsert({ where: { key: RETIRED_PREFIX + domain }, create: { key: RETIRED_PREFIX + domain, value, updatedAt: now }, update: { value, updatedAt: now } });
}

/** `domain` is in use again (saved by a store): never remove it. */
export async function unretireCheckoutDomain(domain: string): Promise<void> {
  await db.appSetting.deleteMany({ where: { key: RETIRED_PREFIX + domain } });
}

function parseRetired(value: string): Retired | null {
  try {
    const v = JSON.parse(value) as Partial<Retired>;
    return typeof v.storeId === "string" && typeof v.removeAt === "string" ? { storeId: v.storeId, removeAt: v.removeAt } : null;
  } catch {
    return null;
  }
}

/** The store that retired `domain` less than 48 h ago (its old links still work), or null. */
export async function retiredDomainOwner(domain: string): Promise<string | null> {
  const row = await db.appSetting.findUnique({ where: { key: RETIRED_PREFIX + domain } });
  return row ? (parseRetired(row.value)?.storeId ?? null) : null;
}

/**
 * Removes from the Vercel project the retired domains whose grace period is over (best effort: a
 * failed removal is retried at the next run). A domain some store uses again is only forgotten.
 */
export async function removeRetiredDomains(deadline: number, now = new Date()): Promise<number> {
  // Due rows only, oldest first (updatedAt is the retirement time, see retireCheckoutDomain): a backlog
  // of domains not due yet never hides the due ones.
  const rows = await db.appSetting.findMany({
    where: { key: { startsWith: RETIRED_PREFIX }, updatedAt: { lte: new Date(now.getTime() - RETIRED_DOMAIN_GRACE_MS) } },
    orderBy: { updatedAt: "asc" },
    take: 20,
  });
  const due = rows.filter((r) => {
    const v = parseRetired(r.value);
    return !v || v.removeAt <= now.toISOString();
  });
  const cfg = vercelConfig();
  let n = 0;
  for (const row of due.slice(0, 5)) {
    if (Date.now() >= deadline) break;
    const domain = row.key.slice(RETIRED_PREFIX.length);
    try {
      const inUse = await db.store.findUnique({ where: { checkoutDomain: domain }, select: { id: true } });
      if (!inUse && cfg) await removeProjectDomain(cfg, domain);
      if (!inUse) await forgetApplePayDomain(parseRetired(row.value)?.storeId ?? null, domain);
      await db.appSetting.deleteMany({ where: { key: row.key, value: row.value } });
      n++;
    } catch (err) {
      log.warn("checkout_domain.remove_failed", "Retired checkout domain could not be removed from Vercel", { domain, err });
    }
  }
  return n;
}

/**
 * Best effort: the retired domain leaves the Whop Apple Pay domains of the store that used it (it
 * only served that store's checkouts). Never throws, never blocks the Vercel removal.
 */
async function forgetApplePayDomain(storeId: string | null, domain: string): Promise<void> {
  if (!storeId) return;
  try {
    const store = await db.store.findUnique({ where: { id: storeId }, select: { whopApiKey: true, whopConnectedAt: true, testMode: true, whopAccountId: true } });
    if (!store?.whopConnectedAt || !store.whopApiKey) return;
    if (await unregisterApplePayDomain(store, domain)) log.info("checkout_domain.apple_pay_removed", "Retired checkout domain removed from Whop Apple Pay domains", { storeId, domain });
  } catch (err) {
    log.warn("checkout_domain.apple_pay_remove_failed", "Retired checkout domain could not be removed from Whop Apple Pay domains", { storeId, domain, err });
  }
}

/* Host of the public APIs ----------------------------------------------------- */

/**
 * True when a public session API is called on a checkout domain that is not this store's (another
 * store's domain, or a stray one pointed at the app): answered 404, a store's sessions are never
 * served under another merchant's name. The app's own hosts (APP_URL, local, *.vercel.app), the
 * store's own domain (verified or not: its DNS points here, it is the merchant's) and the domain it
 * retired less than 48 h ago (open tabs) pass.
 */
export async function isForeignCheckoutHost(req: Request, store: Pick<Store, "id" | "checkoutDomain">, appUrl = env.appUrl): Promise<boolean> {
  const host = hostnameOf(req.headers.get("host"));
  if (isAppHost(host, new URL(appUrl).hostname.toLowerCase(), appExtraHosts())) return false;
  if (host === store.checkoutDomain) return false;
  return (await retiredDomainOwner(host)) !== store.id;
}

/**
 * isForeignCheckoutHost for a route that has not loaded the session: true when session `id` exists
 * and `req` comes on a checkout domain that is not its store's. No query on the app's own hosts.
 */
export async function isForeignSessionHost(req: Request, sessionId: string, appUrl = env.appUrl): Promise<boolean> {
  if (isAppHost(hostnameOf(req.headers.get("host")), new URL(appUrl).hostname.toLowerCase(), appExtraHosts())) return false;
  const s = await db.checkoutSession.findUnique({ where: { id: sessionId }, select: { store: { select: { id: true, checkoutDomain: true } } } });
  return !!s && (await isForeignCheckoutHost(req, s.store, appUrl));
}
