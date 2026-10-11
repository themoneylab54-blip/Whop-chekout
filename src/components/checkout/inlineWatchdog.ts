import { scriptJson } from "./inlineScript";

/*
 * The checkout page's watchdog, an inline script of the server HTML (beside the first prepare): the
 * page's own scripts may never start — a file of the page that fails to load or to run (a network cut,
 * the site switching to a new version while the page loads) leaves the buyer before a page that looks
 * complete but has no payment form. Once the page has loaded (all its scripts in), a page that still
 * hasn't started 10 s later (CheckoutView sets BOOT_FLAG once mounted; the error screen sets
 * ERROR_SCREEN_FLAG, and reports itself) is reported to the server and reloaded, once per session in
 * this tab: the reload brings the files of the version now online. Never while the buyer is in a
 * field (it waits for them to leave it), never when the page started meanwhile; a page in the
 * background waits until it is shown again; a page still loading after 25 s is reported only (a
 * slow connection is no failure: a reload would start it over). The page loaded after that reload
 * says whether it started. The first errors of the page (a script or stylesheet that failed to load,
 * an uncaught error) are kept for the reports, the page's own ones included (WATCH_FLAG).
 */

/** Set by CheckoutView once mounted: the page's scripts started. */
export const BOOT_FLAG = "__wcBooted";
/** Set by the checkout's error screen (it reports itself): the watchdog stands down. */
export const ERROR_SCREEN_FLAG = "__wcErrorScreen";
/** What the watchdog keeps for the page's own reports: { errors, dpl }. */
export const WATCH_FLAG = "__wcWatch";
/** How long a loaded page may take to start before it is taken for broken. */
export const WATCHDOG_AFTER_LOAD_MS = 10_000;
/** A page still loading this long after its HTML is reported (never reloaded). */
export const WATCHDOG_STILL_LOADING_MS = 25_000;
/** The tab's mark of the one reload (per session). */
export const RELOAD_MARK = "wc_reloaded:";
/** The first errors of the page kept for the reports. */
export const WATCH_MAX_ERRORS = 5;

/** Where the page's health reports go (see api/public/sessions/[id]/health). */
export function healthPath(sessionId: string): string {
  return `/api/public/sessions/${encodeURIComponent(sessionId)}/health`;
}

/** What the page's own reports carry from the watchdog (see WATCH_FLAG). */
export type WatchState = { errors: Record<string, string | number>[]; dropped: number; dpl: string | null };

/**
 * The watchdog (ES5, no dependency). `deployment`: the id of the version that served this HTML (its
 * reports tell a page of one version whose files came from another). Times are the page's own clock
 * (performance.now(), as the page's other reports).
 */
export function inlineWatchdogScript(sessionId: string, deployment: string | null): string {
  return (
    `(function(){try{var id=${scriptJson(sessionId)},u=${scriptJson(healthPath(sessionId))},k=${scriptJson(RELOAD_MARK)}+id,done=false,slow=false,after=null;` +
    `var w={errors:[],dropped:0,dpl:${scriptJson(deployment)}};window[${scriptJson(WATCH_FLAG)}]=w;` +
    // This load comes after the watchdog's own reload (null: the browser's storage is blocked).
    `try{after=sessionStorage.getItem(k)==="1"}catch(x){}` +
    `function now(){try{return Math.round(performance.now())}catch(x){return 0}}` +
    `function cut(s){return String(s==null?"":s).slice(0,160)}` +
    // The first errors: the root cause comes first, what follows is often its consequence.
    `function note(o){if(w.errors.length<${WATCH_MAX_ERRORS})w.errors.push(o);else w.dropped++}` +
    `addEventListener("error",function(e){try{var el=e&&e.target;if(el&&el!==window&&el.tagName){if(el.tagName==="SCRIPT"||el.tagName==="LINK")note({res:cut(el.src||el.href)})}else{var o={msg:cut(e&&e.message)};if(e&&e.filename)o.at=cut(e.filename)+":"+(e.lineno||0);note(o)}}catch(x){}},true);` +
    `addEventListener("unhandledrejection",function(e){try{var r=e&&e.reason;note({msg:cut(r&&r.message||r)})}catch(x){}});` +
    `function started(){return!!(window[${scriptJson(BOOT_FLAG)}]||window[${scriptJson(ERROR_SCREEN_FLAG)}])}` +
    `function failed(){var out=[];try{var l=performance.getEntriesByType("resource");for(var i=0;i<l.length&&out.length<6;i++){var r=l[i];if(r.initiatorType==="script"&&(r.responseStatus||0)>=400)out.push({res:cut(r.name),status:r.responseStatus})}}catch(x){}return out}` +
    // A field in use (focused) or filled in by the buyer: a reload would lose it.
    `function inField(){var a=document.activeElement;return!!a&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)}` +
    `function typed(){try{var f=document.querySelectorAll("input,textarea");for(var i=0;i<f.length;i++)if(f[i].type!=="hidden"&&f[i].value!==f[i].defaultValue)return true}catch(x){}return false}` +
    `function send(kind,extra){var o={kind:kind,t:now(),state:document.readyState,visible:document.visibilityState,afterReload:after,dpl:w.dpl,errors:w.errors,dropped:w.dropped,failed:failed()};for(var p in extra)o[p]=extra[p];var b=JSON.stringify(o);` +
    `try{if(navigator.sendBeacon&&navigator.sendBeacon(u,b))return}catch(x){}try{fetch(u,{method:"POST",body:b,keepalive:true}).catch(function(){})}catch(x){}}` +
    `function reload(){if(started())return;if(inField()){document.addEventListener("focusout",function f(){document.removeEventListener("focusout",f);setTimeout(reload,1000)});return}location.reload()}` +
    `function check(){if(done)return;if(started()){done=true;if(after===true&&window[${scriptJson(BOOT_FLAG)}])send("recovered",{});return}` +
    `if(document.visibilityState==="hidden"){document.addEventListener("visibilitychange",function v(){if(document.visibilityState!=="hidden"){document.removeEventListener("visibilitychange",v);setTimeout(check,3000)}});return}` +
    `done=true;var again=false;try{again=sessionStorage.getItem(k)!=="1";if(again)sessionStorage.setItem(k,"1")}catch(x){again=false}` +
    `send("not_booted",{reloading:again,typed:typed()});if(again)setTimeout(reload,300)}` +
    `function arm(){setTimeout(check,${WATCHDOG_AFTER_LOAD_MS})}` +
    `if(document.readyState==="complete")arm();else addEventListener("load",arm);` +
    `setTimeout(function(){if(!slow&&!done&&!started()&&document.readyState!=="complete"){slow=true;send("still_loading",{})}},${WATCHDOG_STILL_LOADING_MS})` +
    `}catch(e){}})();`
  );
}
