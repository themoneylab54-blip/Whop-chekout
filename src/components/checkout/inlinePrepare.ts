import { scriptJson } from "./inlineScript";

/*
 * The page's first /prepare, sent by an inline script while the server HTML is parsed — before the
 * page's JavaScript is downloaded and hydrated (half a second to a second on a phone): the payment
 * form mounts as soon as the page is interactive, instead of one round trip later. The page's own
 * first prepare takes that answer when it would send exactly the same request (same session, same
 * body), at most 30 s after it was sent; whatever happens, only the first prepare looks at it and the
 * answer is gone once looked at (a retry, a later change, a remount ask the server afresh).
 */

/** What a /prepare sends. Optional keys are left out when undefined (as JSON.stringify does). */
export type PrepareBodyInput = {
  countryCode: string;
  shippingRateId: string | null;
  discountCode: string | null;
  addOnIds: string[];
  protection?: boolean;
  quantities?: Record<string, number>;
  clientFailed?: "stripe";
};

/**
 * A /prepare request's body, keys in a fixed order: the inline script's body (built on the server)
 * and the page's first one (built in the browser) are compared as strings.
 */
export function prepareBody(input: PrepareBodyInput): string {
  return JSON.stringify({
    countryCode: input.countryCode,
    shippingRateId: input.shippingRateId,
    discountCode: input.discountCode,
    addOnIds: input.addOnIds,
    protection: input.protection,
    quantities: input.quantities,
    clientFailed: input.clientFailed,
  });
}

/**
 * The page's first prepare on load, as CheckoutView sends it from its initial state: the pre-selected
 * country, no rate chosen yet, no code typed, no order bump, the protection block's default (only when
 * the block is on the page). The same input as the server's early prepare (lib/early-prepare
 * firstLoadInput), so all three meet on one Whop checkout.
 */
export function firstPrepareBody(countryCode: string, protection: boolean | undefined): string {
  return prepareBody({ countryCode, shippingRateId: null, discountCode: null, addOnIds: [], protection });
}

/**
 * The first prepare's protection as CheckoutView starts it: the default of the page's shipping
 * protection block (the one shown), off when it sets none; none at all without the block. Pure.
 */
export function firstPrepareProtection(blocks: readonly { type: string; hidden?: boolean; props?: unknown }[]): boolean | undefined {
  const block = blocks.find((b) => b.type === "shipping_protection" && !b.hidden);
  if (!block) return undefined;
  return (block.props as { defaultOn?: boolean } | undefined)?.defaultOn ?? false;
}

/** An inline answer older than this is not taken (a page left in the background, restored). */
const MAX_AGE_MS = 30_000;
/**
 * An inline request still unanswered this long after it was sent is given up (the page asks itself):
 * a request hanging on a dead connection never holds the payment form. Past the prepare function's
 * own 60 s budget: the server's request is over, so the page's own one never waits on it (a wait
 * that runs out counts as a Whop failure, see SNAPSHOT_WAIT_MS in lib/checkout). The trade-off: a
 * request hanging that long keeps the form away until then (the page reports it at 20 s:
 * prepare_slow); one that fails, as most dead connections do, is asked again at once.
 */
export const INLINE_WAIT_MS = 65_000;

/** The inline request given up (INLINE_WAIT_MS), as takeInlinePrepare rejects with it. */
export function isInlineTimeout(err: unknown): boolean {
  return err instanceof Error && (err as Error & { inlineTimeout?: boolean }).inlineTimeout === true;
}

type InlineAnswer = { status: number; text: string; ref: string | null };
type InlinePrepare = { id: string; body: string; at: number; p: Promise<InlineAnswer> };
type WithInline = { __wcPrepare?: InlinePrepare };

/**
 * The inline script (server HTML): sends the first prepare at once and keeps its answer (status, text,
 * request id) and when it was sent, for the page. A network failure is kept as a rejection (the page
 * then asks itself).
 */
export function inlinePrepareScript(sessionId: string, body: string): string {
  return (
    `(function(){try{var id=${scriptJson(sessionId)},b=${scriptJson(body)};` +
    `var p=fetch("/api/public/sessions/"+encodeURIComponent(id)+"/prepare",{method:"POST",headers:{"Content-Type":"application/json"},body:b})` +
    `.then(function(r){return r.text().then(function(t){return{status:r.status,text:t,ref:r.headers.get("x-request-id")}})});` +
    `p.catch(function(){});window.__wcPrepare={id:id,body:b,at:Date.now(),p:p}}catch(e){}})();`
  );
}

/**
 * The inline prepare's answer as a Response, for the page's first prepare when that one was sent for
 * this session with exactly this body less than 30 s ago; else null. Looked at once: gone afterwards,
 * taken or not. Rejects (the page then asks itself) when the request failed, or is still unanswered
 * INLINE_WAIT_MS after it was sent (isInlineTimeout).
 */
export function takeInlinePrepare(sessionId: string, body: string, now = Date.now()): Promise<Response> | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as WithInline;
  const inline = w.__wcPrepare;
  w.__wcPrepare = undefined;
  if (!inline || inline.id !== sessionId || inline.body !== body || !(now - inline.at >= 0 && now - inline.at < MAX_AGE_MS)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`inline prepare unanswered after ${INLINE_WAIT_MS / 1000} s`), { inlineTimeout: true })),
      Math.max(0, inline.at + INLINE_WAIT_MS - now),
    );
  });
  const answer = inline.p.then((a) => new Response(a.text, { status: a.status, headers: a.ref ? { "x-request-id": a.ref } : undefined }));
  return Promise.race([answer, late]).finally(() => clearTimeout(timer));
}
