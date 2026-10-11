/*
 * The checkout page's watchdog, an inline script of the server HTML (beside the first prepare): the
 * page's own scripts may never start — a file of the page that fails to load or to run (a network cut,
 * the site switching to a new version while the page loads) leaves the buyer before a page that looks
 * complete but has no payment form. Once the page has loaded (all its scripts in), a page that still
 * hasn't started 10 s later (CheckoutView sets BOOT_FLAG once mounted) is reported to the server and
 * reloaded, once per session in this tab: the reload brings the files of the version now online. A
 * page in the background waits until it is shown again; a page still loading after 25 s is reported
 * only (a slow connection is no failure: a reload would start it over).
 */

/** Set by CheckoutView once mounted: the page's scripts started. */
export const BOOT_FLAG = "__wcBooted";
/** How long a loaded page may take to start before it is taken for broken. */
export const WATCHDOG_AFTER_LOAD_MS = 10_000;
/** A page still loading this long after its HTML is reported (never reloaded). */
export const WATCHDOG_STILL_LOADING_MS = 25_000;
/** The tab's mark of the one reload (per session). */
export const RELOAD_MARK = "wc_reloaded:";

/** Where the page's health reports go (see api/public/sessions/[id]/health). */
export function healthPath(sessionId: string): string {
  return `/api/public/sessions/${encodeURIComponent(sessionId)}/health`;
}

/** A JSON value written inside an inline <script> (never closes the tag, never breaks the line). */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * The watchdog (ES5, no dependency). It keeps the page's first errors (a script or stylesheet that
 * failed to load, an uncaught error: 5 at most, cut short) and, in its report, the page's scripts that
 * answered an HTTP error (where the browser tells). The report is a beacon (it survives the reload).
 */
export function inlineWatchdogScript(sessionId: string): string {
  return (
    `(function(){try{var id=${scriptJson(sessionId)},u=${scriptJson(healthPath(sessionId))},k=${scriptJson(RELOAD_MARK)}+id,t0=Date.now(),errs=[],done=false,slow=false,after=null;` +
    // This load comes after the watchdog's own reload (null: storage blocked).
    `try{after=sessionStorage.getItem(k)==="1"}catch(x){}` +
    `function cut(s){return String(s==null?"":s).slice(0,160)}` +
    `function note(o){errs.push(o);if(errs.length>5)errs.shift()}` +
    `addEventListener("error",function(e){try{var el=e&&e.target;if(el&&el!==window&&el.tagName){if(el.tagName==="SCRIPT"||el.tagName==="LINK")note({res:cut(el.src||el.href)})}else note({msg:cut(e&&e.message),at:cut(e&&e.filename)+":"+((e&&e.lineno)||0)})}catch(x){}},true);` +
    `addEventListener("unhandledrejection",function(e){try{var r=e&&e.reason;note({msg:cut(r&&r.message||r)})}catch(x){}});` +
    `function booted(){return!!window[${scriptJson(BOOT_FLAG)}]}` +
    `function failed(){var out=[];try{var l=performance.getEntriesByType("resource");for(var i=0;i<l.length&&out.length<6;i++){var r=l[i];if(r.initiatorType==="script"&&(r.responseStatus||0)>=400)out.push({res:cut(r.name),status:r.responseStatus})}}catch(x){}return out}` +
    `function send(kind){var b=JSON.stringify({kind:kind,t:Date.now()-t0,state:document.readyState,visible:document.visibilityState,afterReload:after,errors:errs,failed:failed()});` +
    `try{if(navigator.sendBeacon&&navigator.sendBeacon(u,b))return}catch(x){}try{fetch(u,{method:"POST",body:b,keepalive:true}).catch(function(){})}catch(x){}}` +
    `function check(){if(done||booted())return;if(document.visibilityState==="hidden"){document.addEventListener("visibilitychange",function v(){if(document.visibilityState!=="hidden"){document.removeEventListener("visibilitychange",v);setTimeout(check,3000)}});return}` +
    `done=true;var again=false;try{again=sessionStorage.getItem(k)!=="1";if(again)sessionStorage.setItem(k,"1")}catch(x){again=false}send("not_booted");if(again)setTimeout(function(){location.reload()},300)}` +
    `function arm(){setTimeout(check,${WATCHDOG_AFTER_LOAD_MS})}` +
    `if(document.readyState==="complete")arm();else addEventListener("load",arm);` +
    `setTimeout(function(){if(!slow&&!done&&!booted()&&document.readyState!=="complete"){slow=true;send("still_loading")}},${WATCHDOG_STILL_LOADING_MS})` +
    `}catch(e){}})();`
  );
}
