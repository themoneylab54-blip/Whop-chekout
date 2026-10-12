import type { useCheckoutEmbedControls } from "@whop/checkout/react";
import { scriptJson } from "./inlineScript";
import { BOOT_FLAG } from "./inlineWatchdog";
import type { WhopFooterRun } from "./whopFooterFit";
import { PANEL_SPINNER_CLASS, PANEL_SPINNER_RING_CLASS, WHOP_CLIP_CLASS, WHOP_CLIP_FRAME_CLASS, WHOP_READY_GRACE_MS } from "./whopFrame";

/*
 * Whop's card form started while the page's own scripts load, instead of once they run: an inline
 * script of the server HTML, after the first prepare's (see inlinePrepare), waits for that prepare's
 * answer and — the page not started yet — opens Whop's checkout right away in the payment panel's
 * slot, with Whop's own plain script (its MIT build, served by this site: WHOP_SDK_PATH), the very
 * frame the React embed would open (see whopEmbed). Measured on a mid phone's profile (Lighthouse's
 * mobile network and CPU, Whop's frame in the page's process as on iOS): Whop's form drawn (its frame
 * at its height) about 2.4 s earlier, the page's own code starting about 0.3 s later (most likely
 * Whop's frame loading alongside, on the phone's network and CPU).
 *
 * Until the page runs, the slot shows what the panel would: the skeleton until Whop's frame is
 * added, then the frame with « Propulsé par Whop » clipped (the server's table of WhopFooterClip's
 * fit, given up as WhopFooterClip gives it up), and the panel's spinner until Whop says "ready". The
 * events Whop sends meanwhile are kept, in order. Once it runs, the payment panel takes the frame
 * over when it is the one it would open (same checkout, same options: see earlyWhopFor), its own clip
 * and spinner replacing these; else it drops it (drop(): the slot goes, with the frame) and opens its
 * own — what the buyer typed in it lost, as when the checkout changes later (rare: the page's first
 * checkout is the inline prepare's, see takeInlinePrepare). Nothing is started when the page runs
 * first, the prepare failed, or the checkout is Stripe's; Whop's script failing to load leaves the
 * skeleton (the page opens its own frame).
 *
 * Whop's plain script, once run, also: loads Whop's tracker (t.whop.tw) unless `window.whop` exists
 * — the React embed never does, so `window.whop` is set (Whop's identity call then does nothing, as
 * today); defines the custom element of Whop's express buttons (whop-express-checkout-button), the
 * first copy to run defining it: the express row's buttons (WhopExpressCheckoutButton renders that
 * element) are then this copy's — the same code byte for byte (tests/whop-vendored), each button
 * with its own frame and events; and watches the page's body for its own elements to mount (a
 * MutationObserver: one quick check of each element the page adds, for the page's life). Its
 * controls (window.wco) find a frame by its element's id.
 */

/** The payment panel's slot the early start opens Whop's form in (in the server HTML: see PaymentPanel). */
export const EARLY_SLOT_ID = "wc-whop-early";
/** The element Whop's plain script mounts its frame in: Whop's controls (window.wco) find the frame by this id. */
export const EARLY_EMBED_ID = "wc-whop-early-embed";
/** Where the early start leaves its frame for the page (see EarlyWhop). */
export const EARLY_FLAG = "__wcEarly";

/** The events Whop's plain script sends (its on-… callbacks), with their arguments. */
export type EarlyWhopEvent = "state" | "complete" | "payment-error" | "address-validation-error";
export type EarlyWhopListener = (event: EarlyWhopEvent, args: unknown[]) => void;

/** The early start's frame, as the payment panel finds it (window[EARLY_FLAG]). */
export type EarlyWhop = {
  configId: string;
  environment: "sandbox" | "production";
  /** Its options (whopEmbedKey's form): only a panel that would open the very same frame takes it. */
  key: string;
  /** The element the frame is in. */
  id: string;
  /**
   * Takes the frame over: the early clip and spinner are dropped for the panel's own (once), the
   * events Whop sent so far are given in order, then each one as it comes. Null gives it back: the
   * events are kept again (an effect's cleanup, React's StrictMode remount).
   */
  take(on: EarlyWhopListener | null): void;
  /**
   * The panel opens its own frame instead (or no longer shows this one): the early start's observers,
   * listener, timer and callbacks go, its frame is removed, and window[EARLY_FLAG] becomes null. Once;
   * nothing is forwarded afterwards.
   */
  drop(): void;
  /** Its clip was given up (no "ready" in WHOP_READY_GRACE_MS): the panel doesn't clip this frame either. */
  clipGaveUp(): boolean;
};

export type EarlyWhopInput = {
  sessionId: string;
  /** whopEmbedFixedAttributes of the panel's card form (all but the checkout, its environment and the return URL). */
  attributes: [string, string][];
  /** The thank-you page's path for the return URL (thankYouPath without via=app: added in the browser, as CheckoutView does). */
  returnPath: string;
  /** whopFooterFitRuns in the language the server checked Whop's form in; null: the footer isn't clipped. */
  fit: readonly WhopFooterRun[] | null;
  /** Whop's plain script (WHOP_SDK_PATH). */
  sdk: string;
};

/**
 * The inline script (ES5, no dependency). The prepare answer is read as preparedFromBody reads it
 * (status 200, Whop's checkout configuration, its environment). Never throws.
 */
export function inlineEarlyWhopScript(input: EarlyWhopInput): string {
  const o = {
    id: input.sessionId,
    slot: EARLY_SLOT_ID,
    el: EARLY_EMBED_ID,
    attrs: input.attributes,
    ret: input.returnPath,
    fit: input.fit,
    sdk: input.sdk,
    grace: WHOP_READY_GRACE_MS,
    // The panel's classes (whopFrame): the clip box, its inner box, the spinner's box, its ring.
    cls: [WHOP_CLIP_CLASS, WHOP_CLIP_FRAME_CLASS, PANEL_SPINNER_CLASS, PANEL_SPINNER_RING_CLASS],
  };
  const flag = scriptJson(EARLY_FLAG);
  return (
    // start(): the frame opened in the slot, once the answer is in (its helpers declared at function level: ES5).
    `(function(){function start(o,a){` +
    // The page already runs (it opens its own frame), an early start already made, a failed answer: nothing.
    `if(window[${scriptJson(BOOT_FLAG)}]||window[${flag}]!==undefined||a.status!==200)return;` +
    `var b=JSON.parse(a.text),slot=document.getElementById(o.slot);` +
    `if(!b||b.provider==="stripe"||typeof b.checkoutConfigurationId!=="string"||!b.checkoutConfigurationId||!slot)return;` +
    `var env=b.environment==="production"?"production":"sandbox",via=false;` +
    `try{via=new URLSearchParams(location.search).get("via")==="app"}catch(x){}` +
    `var attrs=o.attrs.concat([["data-whop-checkout-session",b.checkoutConfigurationId],["data-whop-checkout-environment",env],["data-whop-checkout-return-url",location.origin+o.ret+(via?"&via=app":"")]]);` +
    // Whop's events (its on-… callbacks: window functions named on the element), kept for the page until it takes the frame, then forwarded.
    `var q=[],on=null,taken=false,dropped=false,ready=false,gaveUp=false,mo=null,ro=null,timer=0,me;` +
    `function emit(t,args){if(dropped)return;if(on)on(t,args);else q.push([t,args])}` +
    `var cb=[["state-change","__wcEarlyState",function(s){if(s==="ready"){ready=true;hush()}emit("state",[s])}],` +
    `["complete","__wcEarlyComplete",function(){emit("complete",[].slice.call(arguments))}],` +
    `["payment-error","__wcEarlyPaymentError",function(e){emit("payment-error",[e])}],` +
    `["address-validation-error","__wcEarlyAddressError",function(e){emit("address-validation-error",[e])}]];` +
    `var outer=document.createElement("div"),inner=document.createElement("div"),el=document.createElement("div"),spin=document.createElement("div"),ring=document.createElement("span");` +
    `el.id=o.el;for(var i=0;i<attrs.length;i++)el.setAttribute(attrs[i][0],attrs[i][1]);` +
    `for(i=0;i<cb.length;i++){window[cb[i][1]]=cb[i][2];el.setAttribute("data-whop-checkout-on-"+cb[i][0],cb[i][1])}` +
    // The panel's spinner (see PaymentPanel): from now until Whop says "ready", or the page takes the frame (its own then).
    `spin.className=o.cls[2];ring.className=o.cls[3];spin.appendChild(ring);` +
    `function hush(){if(spin.parentNode)spin.parentNode.removeChild(spin)}` +
    // WhopFooterClip's clip, from the server's table (its fit at each width), following the slot's width.
    `function fitAt(w){var r=o.fit||[];for(var k=0;k<r.length;k++)if(w>=r[k][0]&&w<=r[k][1])return r[k];return null}` +
    `function unclip(){outer.className="";outer.removeAttribute("data-clip");inner.className="";inner.removeAttribute("style")}` +
    `function apply(w){var f=fitAt(w);if(!f)return unclip();outer.className=o.cls[0];outer.setAttribute("data-clip",String(f[3]));` +
    `inner.className=o.cls[1];inner.style.paddingInline=f[2]+"px";inner.style.setProperty("--wc-whop-clip",f[3]+"px")}` +
    `function onResize(){apply(slot.offsetWidth)}` +
    // Its observers, listener and timer off: the frame taken over, dropped, or its clip given up.
    `function quiet(){if(mo){mo.disconnect();mo=null}if(ro){ro.disconnect();ro=null}removeEventListener("resize",onResize);clearTimeout(timer)}` +
    `outer.addEventListener("scroll",function(){outer.scrollTop=0;outer.scrollLeft=0});` +
    `inner.appendChild(el);outer.appendChild(inner);` +
    // Whop's frame, once its script added it: in the skeleton's place (before the next paint), titled as
    // the React embed titles it, clipped as WhopFooterClip clips it.
    `function shown(f){if(mo){mo.disconnect();mo=null}if(!f.title)f.title="Whop Embedded Checkout";` +
    `for(var n=slot.firstChild,x;n;n=x){x=n.nextSibling;if(n!==outer&&n!==spin)slot.removeChild(n)}` +
    `if(!o.fit||taken)return;` +
    // The slot's width as laid out for the next frame (ResizeObserver: no layout forced while the page loads), else read now.
    `if(window.ResizeObserver){ro=new ResizeObserver(function(e){var w=e[0]&&e[0].contentRect.width;if(w!=null)apply(Math.floor(w))});ro.observe(slot)}` +
    `else{apply(slot.offsetWidth);addEventListener("resize",onResize)}` +
    // No "ready" within WhopFooterClip's grace from the frame's mount: the form shown whole, for good.
    `timer=setTimeout(function(){if(ready||taken)return;gaveUp=true;quiet();unclip()},o.grace)}` +
    `mo=new MutationObserver(function(){var f=el.querySelector("iframe");if(f)shown(f)});mo.observe(el,{childList:true,subtree:true});` +
    `me=window[${flag}]={configId:b.checkoutConfigurationId,environment:env,key:JSON.stringify(attrs),id:o.el,` +
    `take:function(f){if(dropped)return;if(f&&!taken){taken=true;var fr=mo&&el.querySelector("iframe");if(fr)shown(fr);quiet();unclip();hush()}` +
    `on=f||null;if(f){var l=q;q=[];for(var k=0;k<l.length;k++)f(l[k][0],l[k][1])}},` +
    `drop:function(){if(dropped)return;dropped=true;quiet();hush();if(outer.parentNode)outer.parentNode.removeChild(outer);` +
    // (Only what is still its own: never another early start's.)
    `on=null;q=[];for(var k=0;k<cb.length;k++)if(window[cb[k][1]]===cb[k][2])window[cb[k][1]]=undefined;if(window[${flag}]===me)window[${flag}]=null},` +
    `clipGaveUp:function(){return gaveUp}};` +
    // Whop's plain script runs only with its controls' global stubbed; its tracker kept off (see above).
    `if(!window.wco)window.wco={injected:true,listening:false,frames:new Map(),identifiedFrames:new Map(),availableCurrencies:new Map()};` +
    `if(!window.whop)window.whop={};` +
    // The frame's element and the spinner join the skeleton; Whop's script (fetched while the prepare
    // ran) mounts the frame in the element as soon as it runs. Unavailable: dropped (the skeleton stays).
    `slot.appendChild(outer);slot.appendChild(spin);` +
    `var s=document.createElement("script");s.src=o.sdk;s.async=true;s.onerror=function(){if(!taken)me.drop()};document.head.appendChild(s)}` +
    // The page's first prepare, sent by the inline prepare (window.__wcPrepare): its answer, once in.
    // Whop's script fetched meanwhile into the browser's cache (the file is immutable): no wait for it
    // then, and nothing run unless the frame is opened. At the default priority: a low one (measured)
    // only added Whop's frame 0.3 s later, the page's code starting no sooner (what slows it is Whop's
    // frame loading, its page and scripts, not this file).
    `try{var o=${scriptJson(o)},P=window.__wcPrepare;if(!P||P.id!==o.id||!window.Map||!window.JSON||!window.MutationObserver)return;` +
    `try{fetch(o.sdk).catch(function(){})}catch(e){}` +
    `P.p.then(function(a){try{start(o,a)}catch(e){}}).catch(function(){})}catch(e){}})();`
  );
}

/** The window as the early start leaves it: its frame, or null once the page runs without one (see earlyWhopPageRuns). */
type WithEarly = { [EARLY_FLAG]?: EarlyWhop | null; wco?: { listening?: boolean } };

/**
 * The early start's frame when it is the one the panel would open: same options (`key`, see
 * whopEmbedKey) and checkout, its element inside the panel's `slot` with Whop's frame in it, Whop's
 * plain script running (its controls ready). Else null: the panel opens its own.
 */
export function earlyWhopFor(key: string, configId: string, slot: HTMLElement | null): EarlyWhop | null {
  if (typeof window === "undefined" || !slot) return null;
  const w = window as unknown as WithEarly;
  const early = w[EARLY_FLAG];
  if (!early || early.configId !== configId || early.key !== key || w.wco?.listening !== true) return null;
  const el = document.getElementById(early.id);
  return el && slot.contains(el) && el.querySelector("iframe") ? early : null;
}

/** The early start's frame, if one was opened and not dropped (the panel takes over the one earlyWhopFor found). */
export function earlyWhopFrame(): EarlyWhop | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as WithEarly)[EARLY_FLAG] ?? null;
}

/** Whop's embed controls (the React embed's ref). */
export type EmbedControls = NonNullable<ReturnType<typeof useCheckoutEmbedControls>["current"]>;

type Wco = {
  submit(id: string, opts?: Parameters<EmbedControls["submit"]>[0]): Promise<void>;
  getEmail(id: string, timeout?: number): Promise<string>;
  setEmail(id: string, email: string, timeout?: number): Promise<void>;
  setAddress(id: string, address: Parameters<EmbedControls["setAddress"]>[0], timeout?: number): Promise<void>;
  getAddress(id: string, timeout?: number): ReturnType<EmbedControls["getAddress"]>;
  setDisplayCurrency(id: string, currency: string, timeout?: number): Promise<void>;
  getAvailableCurrencies(id: string): ReturnType<EmbedControls["getAvailableCurrencies"]>;
};

/**
 * The early frame's controls, as the React embed's ref gives them: Whop's plain script's (window.wco,
 * the frame found by its element's id). The same calls into the frame as the React embed's.
 */
export function earlyWhopControls(id: string): EmbedControls {
  const wco = () => (window as unknown as { wco: Wco }).wco;
  return {
    submit: (opts) => wco().submit(id, opts),
    getEmail: (timeout) => wco().getEmail(id, timeout),
    setEmail: (email, timeout) => wco().setEmail(id, email, timeout),
    setAddress: (address, timeout) => wco().setAddress(id, address, timeout),
    getAddress: (timeout) => wco().getAddress(id, timeout),
    setDisplayCurrency: (currency, timeout) => wco().setDisplayCurrency(id, currency, timeout),
    getAvailableCurrencies: () => wco().getAvailableCurrencies(id),
  };
}

/**
 * The page runs (the payment panel's first layout): true when an early start began (its frame there
 * or on its way, with its spinner: the panel shows none of its own meanwhile); else false, and an
 * early start not begun yet never begins (the panel opens its own frame).
 */
export function earlyWhopPageRuns(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as WithEarly;
  if (w[EARLY_FLAG] === undefined) w[EARLY_FLAG] = null;
  return !!w[EARLY_FLAG];
}
