/*!
 * Whop Checkout — storefront loader.
 * Injected automatically on the shop via a Shopify ScriptTag (or pasted once in theme.liquid).
 * Replaces the Shopify checkout with the store's Whop checkout, following the
 * interception settings from the dashboard. Shopify's own checkout only runs when the merchant
 * switched ours off or for carts it can't sell (subscriptions, gift cards, excluded products), as the
 * session server says; any failure (our server down included) keeps the buyer on the shop with a
 * "try again" message.
 */
(function () {
  "use strict";
  if (window.__whopco) return;
  window.__whopco = true;

  var script =
    document.currentScript ||
    Array.prototype.slice.call(document.querySelectorAll("script[src*='loader.js']")).filter(function (s) {
      return /[?&]store=/.test(s.src);
    })[0];
  if (!script) return;
  var src = new URL(script.src);
  var STORE = src.searchParams.get("store");
  var API = src.origin;
  var params = new URLSearchParams(location.search);
  var DEBUG = params.get("whopco_debug") === "1";
  if (!STORE) return;

  var config = null;
  var configLoading = true;
  // The whole page view on Shopify's checkout: only when ours is switched off or our server unreachable.
  var bypass = false;
  // One click handed back to the theme (see letThrough): the next ones are still ours.
  var passThrough = false;
  var busy = false;

  function log() {
    if (DEBUG && window.console) console.log.apply(console, ["[whop-checkout]"].concat([].slice.call(arguments)));
  }

  function wait(ms, value) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve(value);
      }, ms);
    });
  }

  // After a successful payment the thank-you page links back here: empty the cart once,
  // only if this tab really went to our checkout (a shared link can't wipe someone's cart).
  var pending = false;
  try {
    pending = sessionStorage.getItem("whopco_pending") === "1";
  } catch (e) {}
  if (params.get("whopco_paid") === "1" && pending) {
    try {
      sessionStorage.removeItem("whopco_pending");
    } catch (e) {}
    fetch("/cart/clear.js", { method: "POST", credentials: "same-origin" }).finally(function () {
      params.delete("whopco_paid");
      var q = params.toString();
      history.replaceState(null, "", location.pathname + (q ? "?" + q : "") + location.hash);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Selectors                                                         */
  /* ---------------------------------------------------------------- */

  var CART_CHECKOUT = [
    "button[name='checkout']",
    "input[name='checkout']",
    "a[href='/checkout']",
    "a[href^='/checkout?']",
    "form[action='/checkout'] [type='submit']",
    "[data-checkout-button]",
    ".cart__checkout",
    ".cart__checkout-button",
    "#checkout",
  ];
  var DRAWER_CHECKOUT = [
    "cart-drawer button[name='checkout']",
    "cart-drawer [name='checkout']",
    "cart-notification [name='checkout']",
    ".drawer [name='checkout']",
    ".cart-drawer [name='checkout']",
    "#CartDrawer [name='checkout']",
    "#cart-notification-form [type='submit']",
    ".mini-cart [name='checkout']",
  ];
  var BUY_NOW = [
    ".shopify-payment-button__button--unbranded",
    ".shopify-payment-button__button",
    ".shopify-payment-button button",
    "[data-shopify='payment-button'] button",
  ];

  function matches(el, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      try {
        var hit = el.closest(selectors[i]);
        if (hit) return hit;
      } catch (e) {
        /* invalid custom selector */
      }
    }
    return null;
  }

  // Settings assumed while the store's own load (clicks held meanwhile) or when they can't be read:
  // everything on, with the store's own selectors as its last page had them (localStorage).
  var DEFAULT_INTERCEPTION = { cartCheckout: true, cartDrawer: true, buyNow: true, addToCartDirect: false, customSelectors: "", excludedHandles: [] };
  var cachedCustom = localGet("whopco_custom");
  if (typeof cachedCustom === "string") DEFAULT_INTERCEPTION.customSelectors = cachedCustom;

  // The settings in force: the store's, or the assumed ones while they load.
  function settings() {
    return config ? config.interception : DEFAULT_INTERCEPTION;
  }

  function customSelectors() {
    return String(settings().customSelectors || "")
      .split(/[\n,]/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }

  function checkoutSelectors() {
    var i = settings();
    var list = [];
    if (i.cartCheckout) list = list.concat(CART_CHECKOUT);
    if (i.cartDrawer) list = list.concat(DRAWER_CHECKOUT);
    return list.concat(customSelectors());
  }

  /* ---------------------------------------------------------------- */
  /* Session creation                                                  */
  /* ---------------------------------------------------------------- */

  /*
   * Paid-ad attribution. A landing that carries any UTM or click id is a "touch": it replaces the
   * last touch as a whole (never mixed with an older one) in localStorage `whopco_touch`, and the
   * very first one is kept in `whopco_first_touch` (never overwritten). The last touch expires
   * after the longest attribution window offered (28 days, or the store's if longer); analytics
   * apply the store's window (1, 7 or 28 days) at query time from the touch's date.
   */
  // Click ids: Meta (fbclid), Google Ads (gclid; gbraid / wbraid on iOS app and web-to-app clicks),
  // TikTok (ttclid), Microsoft Ads (msclkid).
  var TOUCH_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id", "fbclid", "gclid", "gbraid", "wbraid", "ttclid", "msclkid"];
  var MAX_TOUCH_DAYS = 28;
  function localGet(k) {
    try {
      var v = localStorage.getItem(k);
      return v ? JSON.parse(v) : null;
    } catch (e) {
      return null;
    }
  }
  function localSet(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) {}
  }
  function touchFromUrl() {
    var t = null;
    TOUCH_KEYS.forEach(function (k) {
      var v = params.get(k);
      if (v) {
        t = t || {};
        t[k] = v.slice(0, 300);
      }
    });
    if (t) t.ts = Date.now();
    return t;
  }
  (function rememberTouch() {
    var t = touchFromUrl();
    if (!t) return;
    localSet("whopco_touch", t);
    if (!localGet("whopco_first_touch")) localSet("whopco_first_touch", t);
  })();
  function attributionDays() {
    var d = config && Number(config.attributionDays);
    return d > 0 && d <= 90 ? d : MAX_TOUCH_DAYS;
  }
  function validTouch(t, days) {
    if (!t || typeof t !== "object" || typeof t.ts !== "number") return null;
    if (days && Date.now() - t.ts > days * 86400000) return null;
    var out = {};
    TOUCH_KEYS.forEach(function (k) {
      if (typeof t[k] === "string" && t[k]) out[k] = t[k].slice(0, 300);
    });
    out.ts = String(t.ts);
    return out;
  }
  // Last paid touch of the longest window analytics can apply (28 days), with its date: the
  // store's window is applied by the server when analytics are read.
  function utm() {
    return validTouch(localGet("whopco_touch"), Math.max(attributionDays(), MAX_TOUCH_DAYS));
  }
  function firstUtm() {
    return validTouch(localGet("whopco_first_touch"), 0);
  }
  function touchValue(k) {
    var t = utm();
    return params.get(k) || (t && t[k]) || null;
  }
  // Ad identifiers for server-side conversions (Meta CAPI, TikTok Events API).
  function cookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function tracking() {
    var out = {};
    var fbp = cookie("_fbp");
    var fbc = cookie("_fbc");
    var fbclid = touchValue("fbclid");
    if (!fbc && fbclid) fbc = "fb.1." + Date.now() + "." + fbclid;
    var ttp = cookie("_ttp");
    var ttclid = touchValue("ttclid");
    if (fbp) out.fbp = fbp.slice(0, 200);
    if (fbc) out.fbc = fbc.slice(0, 300);
    if (ttp) out.ttp = ttp.slice(0, 200);
    if (ttclid) out.ttclid = ttclid.slice(0, 300);
    // Google Analytics client id ("GA1.1.123.456" -> "123.456") for GA4 server-side purchases.
    var ga = cookie("_ga");
    var gaMatch = ga && /^GA\d\.\d\.(\d+\.\d+)$/.exec(ga);
    if (gaMatch) out.ga = gaMatch[1];
    // Shopify's cookie banner: respect a refusal of marketing tracking.
    try {
      var cp = window.Shopify && window.Shopify.customerPrivacy;
      if (cp && typeof cp.marketingAllowed === "function") out.marketing = !!cp.marketingAllowed();
    } catch (e) {}
    return out;
  }

  // Stable anonymous visitor id (first-party cookie, 1 year): the same shopper keeps
  // the same A/B variant across checkouts. Issued and signed by the server (returned when a
  // checkout is created), so a visitor can't choose their arm. Carries no personal data.
  function visitorId() {
    var v = cookie("whopco_vid");
    return v ? v.slice(0, 100) : undefined;
  }
  function keepVisitorId(v) {
    if (typeof v === "string" && /^[A-Za-z0-9._-]{8,100}$/.test(v) && v !== cookie("whopco_vid")) {
      document.cookie = "whopco_vid=" + v + "; path=/; max-age=31536000; SameSite=Lax";
    }
  }

  function overlay(show) {
    var id = "whopco-overlay";
    var el = document.getElementById(id);
    if (!show) {
      if (el) el.remove();
      return;
    }
    if (el) return;
    el = document.createElement("div");
    el.id = id;
    el.setAttribute("aria-live", "polite");
    el.style.cssText =
      "position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;background:rgba(255,255,255,.75);display:flex;align-items:center;justify-content:center;font:500 15px/1.4 system-ui,sans-serif;color:#111";
    el.innerHTML =
      '<div style="display:flex;gap:10px;align-items:center"><span style="width:18px;height:18px;border:2px solid #111;border-right-color:transparent;border-radius:50%;display:inline-block;animation:whopco-spin .8s linear infinite"></span>Redirection vers le paiement sécurisé…</div><style>@keyframes whopco-spin{to{transform:rotate(360deg)}}</style>';
    document.body.appendChild(el);
  }

  function nativeCheckout(items) {
    bypass = true;
    overlay(false);
    if (items && items.some(function (i) { return i.selling_plan || i.properties; })) {
      // A subscription or a personalized / bundle item bought with "buy now": add it with its plan
      // and properties (a cart permalink would lose them), then Shopify's checkout. The cart is
      // emptied first: "buy now" buys just this item, not whatever the cart already held.
      fetch("/cart/clear.js", { method: "POST", credentials: "same-origin" })
        .catch(function () {})
        .then(function () {
          return fetch("/cart/add.js", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({
              items: items.map(function (i) {
                var it = { id: Number(i.variant_id), quantity: i.quantity };
                if (i.selling_plan) it.selling_plan = Number(i.selling_plan);
                if (i.properties) it.properties = i.properties;
                return it;
              }),
            }),
          });
        })
        .finally(function () {
          location.href = "/checkout";
        });
    } else if (items) {
      // Buy-now fallback: Shopify cart permalink for just these items.
      location.href =
        "/cart/" +
        items
          .map(function (i) {
            return i.variant_id + ":" + i.quantity;
          })
          .join(",");
    } else {
      location.href = "/checkout";
    }
  }

  function excluded(cartItems) {
    var list = config.interception.excludedHandles || [];
    if (!list.length) return false;
    return cartItems.some(function (i) {
      return list.indexOf(i.handle) !== -1;
    });
  }

  // Selling plan of a /cart.js line (subscription) or of a product form ("selling_plan" field).
  function sellingPlan(i) {
    var alloc = i.selling_plan_allocation;
    var plan = (alloc && alloc.selling_plan && alloc.selling_plan.id) || i.selling_plan;
    return plan ? String(plan) : null;
  }

  function unsupported(cartItems) {
    return cartItems.some(function (i) {
      return !!sellingPlan(i) || i.gift_card === true;
    });
  }

  /*
   * Bundle / personalization apps. Line item properties (hidden "_…" keys included) go with the
   * line; the server re-reads the cart itself for prices (never these figures). Lines an app may
   * have priced (bundle components, a final price that isn't the plain price minus its discounts)
   * are flagged so the server checks them, or sends the buyer to Shopify's checkout.
   */
  function lineProperties(raw) {
    if (!raw || typeof raw !== "object") return null;
    var out = {};
    var n = 0;
    Object.keys(raw).forEach(function (k) {
      var v = raw[k];
      if (n >= 25 || v == null || !k) return;
      if (typeof v === "object") {
        try {
          v = JSON.stringify(v);
        } catch (e) {
          return;
        }
      }
      // Byte for byte: hidden app keys ("_…", "__kaching_bundles" JSON) are kept whole, or left out
      // when over 2000 characters (a cut JSON would be invalid app data).
      v = String(v);
      if (String(k).charAt(0) === "_" && v.length > 2000) return log("hidden property too long, left out:", String(k).slice(0, 60));
      out[String(k).slice(0, 255)] = String(k).charAt(0) === "_" ? v : v.slice(0, 255);
      n++;
    });
    return n ? out : null;
  }

  function appPriced(cart) {
    var items = cart.items || [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var comps = it.item_components || it.components;
      if (it.has_components === true || (Array.isArray(comps) && comps.length)) return true;
      if (typeof it.final_line_price !== "number") continue;
      var allocated = 0;
      (it.line_level_discount_allocations || []).forEach(function (a) {
        allocated += Number((a && a.amount) || 0);
      });
      if (typeof it.original_line_price === "number" && it.final_line_price + allocated !== it.original_line_price) return true;
      if (typeof it.price === "number" && typeof it.original_price === "number" && it.price !== it.original_price) return true;
    }
    return false;
  }

  function hasAutomaticDiscounts(cart) {
    var apps = cart.cart_level_discount_applications || [];
    for (var i = 0; i < apps.length; i++) if (apps[i] && apps[i].type === "automatic") return true;
    var items = cart.items || [];
    for (var j = 0; j < items.length; j++) {
      var allocs = items[j].line_level_discount_allocations || [];
      for (var k = 0; k < allocs.length; k++) if (allocs[k] && allocs[k].discount_application && allocs[k].discount_application.type === "automatic") return true;
    }
    return false;
  }

  // The session POST goes to the store's checkout domain (checkout.<shop>.com). If that domain can't be
  // reached from this browser (DNS not propagated here, network filter, certificate being renewed), the
  // same request goes to the app's own API (where this script comes from).
  // Reachability is decided up front by a light ping (started when the config loads, 3 s max so a slow
  // mobile network isn't taken for an unreachable domain; a click only waits for a ping still running),
  // so the POST itself only has a long time limit (25 s, see timedFetch) that a slow cart pricing never
  // reaches; and the POST carries a random key of the click, so a retry on the app's API gets the session
  // the first request created (one session, one conversion). The ping fetches a static file served by
  // the CDN (never a function: no cold start, no cost per pageview), and its answer is kept for 10
  // minutes in the tab (one ping per visit, not per page).
  var viaApp = false;
  var domainPing = null;
  var domainReachable = null; // the ping's answer once known (the warm-up follows it too)
  var PING_ASSET = "/checkout-icon.svg";
  var PING_CACHE_MS = 10 * 60 * 1000;
  function sessionsUrl() {
    return API + "/api/public/sessions";
  }
  function cachedPing(origin) {
    try {
      var v = JSON.parse(sessionStorage.getItem("whopco_ping") || "null");
      if (v && v.origin === origin && typeof v.ok === "boolean" && Date.now() - v.at < PING_CACHE_MS && Date.now() >= v.at) return v.ok;
    } catch (e) {
      /* storage blocked: ping again */
    }
    return null;
  }
  function pingCheckoutDomain() {
    if (!config || !config.sessionEndpoint || config.sessionEndpoint === sessionsUrl()) return;
    var origin;
    try {
      origin = new URL(config.sessionEndpoint).origin;
    } catch (e) {
      return;
    }
    var known = cachedPing(origin);
    if (known !== null) {
      domainReachable = known;
      domainPing = Promise.resolve(known);
      return;
    }
    // Opaque (no-cors) answer: any HTTP answer means the domain is reachable; only a network error isn't.
    var ping = fetch(origin + PING_ASSET, { mode: "no-cors", cache: "no-store", credentials: "omit" }).then(
      function () {
        return true;
      },
      function () {
        return false;
      }
    );
    var timeout = new Promise(function (resolve) {
      setTimeout(function () {
        resolve(false);
      }, 3000);
    });
    domainPing = Promise.race([ping, timeout]).then(function (ok) {
      domainReachable = ok;
      log(ok ? "checkout domain reachable" : "checkout domain unreachable, the app's API will be used");
      try {
        sessionStorage.setItem("whopco_ping", JSON.stringify({ origin: origin, ok: ok, at: Date.now() }));
      } catch (e) {
        /* storage blocked */
      }
      return ok;
    });
  }
  function requestKey() {
    try {
      var b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return Array.prototype.map
        .call(b, function (x) {
          return ("0" + x.toString(16)).slice(-2);
        })
        .join("");
    } catch (e) {
      return (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 40);
    }
  }
  // One session request with its answer read, 25 s at most in every browser (a plain timer; the request
  // is also aborted where AbortController exists). Past that it's a network error (a TypeError): the
  // app's API next, or the automatic retry, with the same key.
  var SESSION_TIMEOUT = 25000;
  function timedFetch(url, init) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer;
    var limit = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new TypeError("no answer within " + SESSION_TIMEOUT / 1000 + " s"));
      }, SESSION_TIMEOUT);
    });
    var answer = fetch(url, ctrl ? Object.assign({}, init, { signal: ctrl.signal }) : init).then(function (res) {
      return res.text().then(function (text) {
        return { ok: res.ok, status: res.status, text: text };
      });
    });
    return Promise.race([answer, limit]).then(
      function (r) {
        clearTimeout(timer);
        return r;
      },
      function (err) {
        clearTimeout(timer);
        throw err;
      }
    );
  }
  function postSession(init) {
    var direct = sessionsUrl();
    viaApp = false;
    if (config.sessionEndpoint === direct) return timedFetch(direct, init);
    return (domainPing || Promise.resolve(true)).then(function (reachable) {
      if (!reachable) {
        viaApp = true;
        return timedFetch(direct, init);
      }
      return timedFetch(config.sessionEndpoint, init).catch(function (err) {
        log("checkout domain unreachable, retrying on the app:", err && err.message);
        viaApp = true;
        // The automatic retry goes straight to the app too (never two more waits on a silent domain).
        domainReachable = false;
        domainPing = Promise.resolve(false);
        return timedFetch(direct, init);
      });
    });
  }

  // After that fallback, the checkout opens on the app's host too (via=app keeps it there).
  function onAppHost(url) {
    if (!viaApp) return url;
    try {
      var u = new URL(url);
      if (u.origin === API) return url;
      var app = new URL(u.pathname + u.search + u.hash, API);
      app.searchParams.set("via", "app");
      return app.href;
    } catch (e) {
      return url;
    }
  }

  // Shopify's cart: an unreadable one is retried, never taken for an empty cart.
  function readCart() {
    return fetch("/cart.js", { credentials: "same-origin", headers: { Accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw Object.assign(new Error("cart.js " + r.status), { retryable: true });
      return r.json();
    });
  }
  function cartLines(cart) {
    return ((cart && cart.items) || []).filter(function (i) {
      return i.quantity > 0;
    });
  }
  // The shop's cart page, in the buyer's language when the theme gives it (/fr/cart).
  function cartPage() {
    var root = window.Shopify && window.Shopify.routes && window.Shopify.routes.root;
    return (typeof root === "string" && /^\/([a-z]{2}(-[a-z]{2})?\/?)?$/i.test(root) ? root.replace(/\/?$/, "/") : "/") + "cart";
  }
  function httpUrl(u) {
    try {
      var url = typeof u === "string" ? new URL(u) : null;
      return !!url && (url.protocol === "https:" || (url.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)));
    } catch (e) {
      return false;
    }
  }

  function goToCheckout(items, retried, key) {
    if (busy) return;
    busy = true;
    // One key per click, kept by the automatic retry: a lost answer never makes a second session.
    key = key || requestKey();
    var startedAt = Date.now();
    overlay(true);
    var cartPromise = items
      ? Promise.resolve({ items: items })
      : readCart().then(function (cart) {
          // Empty: an "add to cart" may still be on its way, so once more 600 ms later.
          return cartLines(cart).length ? cart : wait(600).then(readCart);
        });
    cartPromise
      .then(function (cart) {
        var cartItems = cartLines(cart);
        if (!cartItems.length) throw Object.assign(new Error("empty cart"), { empty: true });
        if (excluded(cartItems)) throw nativeError("excluded product");
        // Subscriptions (selling plans) and gift cards stay on Shopify's checkout, whole cart.
        if (unsupported(cartItems)) throw nativeError("subscription or gift card");
        return postSession({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            store: STORE,
            items: cartItems.map(function (i) {
              var item = { variant_id: i.variant_id || i.id, quantity: i.quantity };
              var plan = sellingPlan(i);
              if (plan) item.selling_plan = plan;
              if (i.gift_card === true) item.gift_card = true;
              var props = lineProperties(i.properties);
              if (props) item.properties = props;
              return item;
            }),
            returnUrl: location.origin + "/",
            utm: utm() || undefined,
            firstUtm: firstUtm() || undefined,
            tracking: tracking(),
            visitorId: visitorId(),
            // The server re-reads this cart (by its token) to keep the automatic discounts Shopify computed.
            cartToken: typeof cart.token === "string" ? cart.token : undefined,
            automaticDiscounts: hasAutomaticDiscounts(cart),
            appPricing: appPriced(cart),
            // Cart note and attributes, copied to the order (the server's own re-read wins).
            note: typeof cart.note === "string" && cart.note ? cart.note.slice(0, 5000) : undefined,
            attributes: lineProperties(cart.attributes) || undefined,
            // Same key on the retries (app's API, automatic retry): the server answers the same session.
            requestKey: key,
          }),
        });
      })
      .then(function (res) {
        var body = {};
        try {
          body = JSON.parse(res.text) || {};
        } catch (e) {
          /* a proxy's HTML error page (502, 504): a server error, not a broken answer */
        }
        // Only an http(s) address is opened (never a "javascript:" one).
        if (!res.ok || !httpUrl(body.url)) {
          var err = new Error(body.error || "session failed (" + res.status + ")");
          // Only the carts Shopify keeps (checkout off, subscription, gift card, excluded).
          err.native = !!body.native;
          // A server error or a passing refusal the server marks (cart_changed, in_progress…); not a
          // 429: the same minute would refuse again.
          err.retryable = body.retryable === true || res.status >= 500;
          throw err;
        }
        body.url = onAppHost(body.url);
        keepVisitorId(body.visitorId);
        log("redirect", body.url, "after", Date.now() - startedAt, "ms");
        if (DEBUG) badge("Whop Checkout : session prête en " + (Date.now() - startedAt) + " ms", true);
        try {
          sessionStorage.setItem("whopco_pending", "1");
        } catch (e) {}
        location.href = body.url;
      })
      .catch(function (err) {
        if (err && err.empty) {
          // Still empty: the shop's cart page, never Shopify's checkout.
          busy = false;
          overlay(false);
          log("empty cart");
          location.href = cartPage();
          return;
        }
        if (err && err.native) {
          busy = false;
          log("Shopify checkout:", err.message);
          nativeCheckout(items);
          return;
        }
        // A network or server hiccup: once more on its own (same key, after a short pause) before
        // telling the buyer. Still busy meanwhile: one flow per click.
        if (!retried && (!err || err.retryable || err instanceof TypeError)) {
          log("checkout failed, retrying:", err && err.message);
          return wait(800).then(function () {
            busy = false;
            goToCheckout(items, true, key);
          });
        }
        busy = false;
        log("checkout failed:", err && err.message);
        failed(err && err.message, items);
      });
  }

  function nativeError(message) {
    var e = new Error(message);
    e.native = true;
    return e;
  }

  // The checkout couldn't open: the buyer stays on the shop with a way to try again (never
  // Shopify's checkout). With ?whopco_debug=1 the reason shows too.
  function failed(reason, items) {
    overlay(false);
    if (DEBUG) badge("Whop Checkout : échec — " + (reason || "erreur inconnue"), false);
    var id = "whopco-error";
    var old = document.getElementById(id);
    if (old) old.remove();
    var el = document.createElement("div");
    el.id = id;
    el.setAttribute("role", "alert");
    el.style.cssText =
      "position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;font:500 15px/1.4 system-ui,sans-serif;color:#111";
    var card = document.createElement("div");
    card.style.cssText = "background:#fff;border-radius:12px;padding:20px;max-width:360px;width:100%;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.2)";
    var text = document.createElement("p");
    text.style.cssText = "margin:0 0 16px";
    text.textContent = /^fr/i.test(document.documentElement.lang || navigator.language || "")
      ? "Le paiement n'a pas pu s'ouvrir. Veuillez réessayer."
      : "The checkout couldn't open. Please try again.";
    var retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = /^fr/i.test(document.documentElement.lang || navigator.language || "") ? "Réessayer" : "Try again";
    retry.style.cssText = "background:#111;color:#fff;border:0;border-radius:8px;padding:10px 18px;font:600 15px system-ui,sans-serif;cursor:pointer";
    retry.addEventListener("click", function () {
      el.remove();
      goToCheckout(items);
    });
    var close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Fermer");
    close.style.cssText = "background:none;border:0;font:400 22px system-ui,sans-serif;margin-left:12px;cursor:pointer;color:#555";
    close.addEventListener("click", function () {
      el.remove();
    });
    card.appendChild(text);
    card.appendChild(retry);
    card.appendChild(close);
    el.appendChild(card);
    document.body.appendChild(el);
  }

  function productFormItems(el) {
    // The button's own product form; its section's only one; the page's only one (never a guess among
    // several); else the product page's selected variant (?variant=).
    var forms = document.querySelectorAll("form[action*='/cart/add']");
    var section = el.closest && el.closest(".shopify-section, [id^='shopify-section'], section");
    var sectionForms = section ? section.querySelectorAll("form[action*='/cart/add']") : [];
    var form =
      (el.closest && el.closest("form[action*='/cart/add']")) ||
      (el.closest && el.closest("product-form, .product-form, [data-product-form]") &&
        el.closest("product-form, .product-form, [data-product-form]").querySelector("form[action*='/cart/add']")) ||
      (sectionForms.length === 1 ? sectionForms[0] : null) ||
      (forms.length === 1 ? forms[0] : null);
    if (!form) {
      var variant = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?products\//i.test(location.pathname) && new URLSearchParams(location.search).get("variant");
      return variant && /^\d+$/.test(variant) ? [{ variant_id: variant, quantity: 1, handle: location.pathname.split("/products/")[1] || "" }] : null;
    }
    var fd = new FormData(form);
    var id = fd.get("id");
    if (!id) return null;
    var qty = parseInt(fd.get("quantity") || "1", 10) || 1;
    var item = { variant_id: String(id), quantity: qty, handle: location.pathname.split("/products/")[1] || "" };
    var plan = fd.get("selling_plan");
    if (plan) item.selling_plan = String(plan);
    // Personalization fields of the product form ("properties[Gravure]").
    var props = {};
    var hasProps = false;
    fd.forEach(function (v, k) {
      var m = /^properties\[(.+)\]$/.exec(k);
      if (m && typeof v === "string" && v !== "") {
        props[m[1]] = v;
        hasProps = true;
      }
    });
    if (hasProps) item.properties = lineProperties(props);
    return [item];
  }

  /* ---------------------------------------------------------------- */
  /* Listeners (capture phase, before the theme's own handlers)        */
  /* ---------------------------------------------------------------- */

  // Any other checkout link or button of a theme (a link to this shop's checkout, a "checkout" button
  // named differently, a "Checkout" / "Paiement" button in the cart or its drawer).
  var ANY_CHECKOUT = ["[name='checkout']"];
  // The whole label of a theme's checkout button (lowercase, accents left out): never "Acheter", "Valider"
  // alone or "Payer en 3 fois".
  var CHECKOUT_LABEL = /^(check[ -]?out|secure check[ -]?out|(proceed|go|continue) to (check[ -]?out|payment)|paiement( securise)?|payer|(proceder|passer|aller|continuer) (au|vers le) paiement|passer (a )?la caisse|passer commande|passer (a )?la commande|valider (la|ma) commande|valider (mon|le) panier|finaliser (la|ma) commande|commander|kasse|(weiter )?zur kasse( gehen)?|bestellen|pagar|tramitar pedido|finalizar compra|realizar pedido|cassa|vai alla cassa|procedi al pagamento|afrekenen|naar de kassa)( (maintenant|now|securely|en toute securite))?$/;
  // Labels a discount code's own button could carry too (« Commander » beside a code field isn't the checkout).
  var AMBIGUOUS_LABEL = /^(commander|payer|pagar|bestellen|kasse|cassa)$/;
  var DISCOUNT_FIELD = "input[name*='discount' i], input[name*='coupon' i], input[id*='discount' i]";
  // Cart page, checkout and cart permalink paths, with or without a market's language prefix (/fr/cart,
  // /en-us/checkout, /cart/111:1,222:2).
  var CART_PAGE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?cart\/?$/i;
  var CHECKOUT_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?checkouts?(\/|$)/i;
  var PERMALINK_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?cart\/(\d+:\d+(?:,\d+:\d+)*)\/?$/i;

  // An address of this shop (relative ones included), never another site's.
  function shopUrl(href) {
    try {
      var u = new URL(href, document.baseURI);
      return u.origin === location.origin ? u : null;
    } catch (e) {
      return null;
    }
  }
  // A link to this shop's checkout (/checkout, /checkouts/…).
  function checkoutLink(t) {
    var a = t.closest && t.closest("a[href], area[href]");
    var u = a && shopUrl(a.getAttribute("href"));
    return u && CHECKOUT_PATH.test(u.pathname) ? a : null;
  }
  // A cart permalink of this shop (/cart/111:1,222:2: a page builder's "buy now", a reorder link): its
  // items, bought like a "buy now".
  function permalinkItems(t) {
    var a = t.closest && t.closest("a[href], area[href]");
    var u = a && shopUrl(a.getAttribute("href"));
    // ?storefront=true fills the cart without a checkout: the theme's.
    var m = u && u.searchParams.get("storefront") !== "true" && PERMALINK_PATH.exec(u.pathname);
    return m
      ? m[1].split(",").map(function (pair) {
          var p = pair.split(":");
          return { variant_id: p[0], quantity: parseInt(p[1], 10) || 1 };
        })
      : null;
  }

  // A button's words without a price or separator after them: "Passer la commande • 49,00 €",
  // "Checkout - $49.00" and "Paiement →" read "passer la commande", "checkout" and "paiement".
  function buttonLabel(btn) {
    var s = String((btn.tagName === "INPUT" ? btn.value : btn.textContent) || btn.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ")
      .split(/[•·⋅|]| [-–—:] /)[0];
    if (s.length > 80) return ""; // a block of text, not a button's label
    s = s
      .replace(/\(?\s*([$€£¥]|\b[A-Z]{3})?\s?\d[\d\s.,']*([$€£¥]|[A-Z]{3}\b)?\s*\)?\s*$/, "")
      .replace(/[\s→›»>:.!–—-]+$/, "")
      .trim()
      .toLowerCase();
    s = s.normalize ? s.normalize("NFD").replace(/[\u0300-\u036f]/g, "") : s;
    // A lock or an emoji around the words ("🔒 Paiement sécurisé", "Checkout ✓").
    return s.replace(/^[^a-z]+|[^a-z]+$/g, "");
  }
  // "cart" as a word of a tag, id or class ("cart-drawer", "CartDrawer", "mini_cart"), or a word ending in
  // it (cart-drawer apps: "upcart", "minicart", "sidecart", "slidecart", "ajaxcart"), not "js-cartography".
  var CART_TOKEN = /^([a-z]*cart|cart(drawer|popup|notification|items?|footer|summary|modal|panel|sidebar|page|form|wrapper|container|content))$/;
  function cartWord(s) {
    var words = String(s || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
    for (var k = 0; k < words.length; k++) if (CART_TOKEN.test(words[k])) return true;
    return false;
  }
  // A form posting to the cart (/cart, /fr/cart, /cart/update…), not "add to cart".
  function cartForm(form) {
    var action = (form && form.getAttribute && form.getAttribute("action")) || "";
    return /\/cart(\/|\?|#|$)/.test(action) && !/\/cart\/add/.test(action);
  }
  // In the cart (drawer, popup, page): a cart container strictly below <body> (a "cart-open" class on
  // <body> or <html> would make every button a checkout), or the cart form's own button (form="cart").
  function inCart(btn) {
    for (var el = btn.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (cartWord(el.tagName) || cartWord(el.id) || cartWord(el.getAttribute("class")) || (el.tagName === "FORM" && cartForm(el))) return true;
    }
    return !!(btn.form && cartForm(btn.form));
  }
  // A discount code's button: the code field right beside it, or in its own form (not the cart's).
  function discountButton(btn) {
    try {
      var kids = btn.parentElement ? btn.parentElement.children : [];
      for (var k = 0; k < kids.length; k++) if (kids[k] !== btn && kids[k].matches(DISCOUNT_FIELD)) return true;
      return !!(btn.form && !cartForm(btn.form) && btn.form.querySelector(DISCOUNT_FIELD));
    } catch (e) {
      return false;
    }
  }
  function genericCheckout(t) {
    var i = settings();
    if (!(i.cartCheckout || i.cartDrawer)) return null;
    var hit = matches(t, ANY_CHECKOUT) || checkoutLink(t);
    if (hit) return hit;
    var btn = t.closest && t.closest("button, a, input[type='submit'], [role='button']");
    if (!btn) return null;
    // Never a product's own button ("buy now", "add to cart", a sticky bar's form="product-form-1").
    if (matches(btn, BUY_NOW) || btn.closest("form[action*='/cart/add'], product-form") || (btn.form && /\/cart\/add/.test(btn.form.getAttribute("action") || ""))) return null;
    var label = buttonLabel(btn);
    if (!label || label.length > 40 || !CHECKOUT_LABEL.test(label) || (AMBIGUOUS_LABEL.test(label) && discountButton(btn))) return null;
    // Only in the cart, even on the cart page ("Commander" in its menu isn't a checkout).
    return inCart(btn) ? btn : null;
  }

  // A click once the config is loaded (onClick and held clicks alike): opens our checkout and returns
  // true for one we take ("buy now" with its product form's items, a cart permalink's items, a cart
  // checkout), false otherwise.
  function intercept(t) {
    var i = config.interception;
    if (i.buyNow && matches(t, BUY_NOW)) {
      var items = productFormItems(t);
      if (items) goToCheckout(items);
      return !!items;
    }
    var linked = (i.buyNow || i.cartCheckout) && permalinkItems(t);
    if (linked) {
      goToCheckout(linked);
      return true;
    }
    if (matches(t, checkoutSelectors()) || genericCheckout(t)) {
      goToCheckout(null);
      return true;
    }
    return false;
  }
  // A submission that opens the checkout: a form posting to this shop's checkout, or the cart form sent
  // by one of its checkout buttons (clicked, or the theme's requestSubmit).
  function checkoutSubmission(form, submitter) {
    var i = settings();
    if (!(i.cartCheckout || i.cartDrawer)) return false;
    var u = shopUrl(form.getAttribute("action") || "");
    if (u && CHECKOUT_PATH.test(u.pathname)) return true;
    if (!cartForm(form)) return false;
    // Sent by the theme's script without a button: its hidden "checkout" field says so.
    if (!submitter) return !!form.querySelector("input[name='checkout']");
    return submitter.name === "checkout" || !!matches(submitter, checkoutSelectors()) || !!genericCheckout(submitter);
  }

  // A held click or submission handed back to the theme (its handlers, its default action): this one
  // only, the next ones are still ours.
  function letThrough(w) {
    var t = w.el;
    while (t && typeof t.click !== "function") t = t.parentElement; // an <svg> icon: its button
    passThrough = true;
    try {
      if (w.form) resubmit(w.form, w.submitter);
      else if (t) t.click();
    } finally {
      passThrough = false;
    }
  }
  function resubmit(form, submitter) {
    try {
      if (typeof form.requestSubmit === "function") return submitter ? form.requestSubmit(submitter) : form.requestSubmit();
    } catch (e) {
      /* a submitter that isn't this form's: a plain submit */
    }
    form.submit();
  }

  // A checkout click or submission before the config arrived: held until it does (8 s at most), judged
  // with the assumed settings; never Shopify's checkout on its own.
  var waiting = [];
  function hold(e, what) {
    e.preventDefault();
    e.stopImmediatePropagation();
    overlay(true);
    waiting.push(what);
  }
  function holdUntilConfig(e) {
    var t = e.target;
    if (t instanceof Element && (matches(t, BUY_NOW) || permalinkItems(t) || matches(t, checkoutSelectors()) || genericCheckout(t))) hold(e, { el: t });
  }
  // The held click or submission (the last one: a double click is one intent), decided like onClick or
  // onSubmit once the config is known; one we don't take goes back to the theme. Checkout switched off
  // (or an unknown store): Shopify's checkout for this page view.
  function releaseWaiting() {
    var list = waiting;
    waiting = [];
    if (!list.length) return;
    overlay(false);
    var w = list[list.length - 1];
    if (config && config.enabled) {
      if (w.form && checkoutSubmission(w.form, w.submitter)) return goToCheckout(null);
      if (!w.form && intercept(w.el)) return;
    } else {
      bypass = true;
    }
    letThrough(w);
  }

  // Our server's settings couldn't be read (twice, or not within 8 s for a waiting click): the checkout
  // is tried anyway with the assumed settings, and the session server decides — checkout switched off,
  // an excluded product, a subscription: Shopify's checkout; our server down: « Réessayer ».
  // Never Shopify's checkout on our own.
  function assumedConfig() {
    return { enabled: true, interception: DEFAULT_INTERCEPTION, sessionEndpoint: sessionsUrl() };
  }

  function onClick(e) {
    if (passThrough) return;
    if (!bypass && configLoading) return holdUntilConfig(e);
    if (bypass || !config || !config.enabled) return;
    var t = e.target;
    if (t instanceof Element && intercept(t)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  function onSubmit(e) {
    if (passThrough || bypass) return;
    var form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    var action = form.getAttribute("action") || "";
    var submitter = e.submitter;
    // Before the config: a checkout submission waits for it too (a button without a type in a checkout
    // form, the theme's requestSubmit on the cart form).
    if (configLoading) {
      if (checkoutSubmission(form, submitter)) hold(e, { form: form, submitter: submitter });
      return;
    }
    if (!config || !config.enabled) return;

    if (checkoutSubmission(form, submitter)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      goToCheckout(null);
      return;
    }

    // "Add to cart → straight to checkout" mode (single-product stores).
    if (config.interception.addToCartDirect && /\/cart\/add/.test(action)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      overlay(true);
      fetch("/cart/add.js", { method: "POST", body: new FormData(form), credentials: "same-origin" })
        .then(function (r) {
          if (!r.ok) throw new Error("add failed");
          goToCheckout(null);
        })
        .catch(function () {
          // Shopify's own "add to cart" (its cart page, not its checkout; form.submit() fires no
          // submit event, so later checkout clicks are still ours).
          overlay(false);
          form.submit();
        });
    }
  }

  document.addEventListener("click", onClick, true);
  document.addEventListener("submit", onSubmit, true);

  // Back from our checkout (back/forward cache): the page returns as it was left, spinner included.
  // Everything is decided again from here.
  window.addEventListener("pageshow", function (e) {
    if (!e.persisted) return;
    busy = false;
    bypass = false;
    overlay(false);
    var err = document.getElementById("whopco-error");
    if (err) err.remove();
  });

  /*
   * Warm-up: when the buyer heads for the checkout (pointer over or touch on a checkout button, the
   * cart opened, the cart page), the checkout's server and its connections are woken before the
   * click: a cold server is most of the wait after it. At most once a minute per tab (once the server
   * answered, its time is kept in sessionStorage for the tab's next pages), nothing created.
   */
  var warmedAt = 0;
  var CART_OPENERS = ["a[href='/cart']", "a[href$='/cart']", "cart-icon", "[aria-controls*='cart' i]", "[data-cart-toggle]", "[href='#cart']"];
  function preconnect(href) {
    try {
      var origin = new URL(href).origin;
      if (document.querySelector("link[rel='preconnect'][href='" + origin + "']")) return;
      var l = document.createElement("link");
      l.rel = "preconnect";
      l.href = origin;
      l.crossOrigin = "anonymous";
      document.head.appendChild(l);
    } catch (e) {}
  }
  function warmedRecently() {
    var at = warmedAt;
    try {
      at = Math.max(at, Number(sessionStorage.getItem("whopco_warm")) || 0);
    } catch (e) {
      /* storage blocked: this page's own time */
    }
    var age = Date.now() - at;
    return age >= 0 && age < 60000;
  }
  function warm() {
    if (!config || !config.enabled || warmedRecently()) return;
    warmedAt = Date.now();
    var at = warmedAt;
    // Where the click's POST will go: the app's own API when the checkout domain is unreachable from here.
    var endpoint = domainReachable === false ? sessionsUrl() : config.sessionEndpoint || sessionsUrl();
    preconnect(endpoint);
    preconnect(API);
    try {
      // No keepalive: a preflighted keepalive request is unreliable in some browsers.
      fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"warm":true}' })
        .then(function () {
          // Kept for the tab's next pages once it answered: one cut short by leaving the page doesn't count.
          try {
            sessionStorage.setItem("whopco_warm", String(at));
          } catch (e) {}
        })
        .catch(function () {});
    } catch (e) {}
    log("warm-up sent");
  }
  function onIntent(e) {
    // The throttle before any selector: pointerover fires on every element the pointer crosses.
    if (!config || !config.enabled || warmedRecently()) return;
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (matches(t, checkoutSelectors()) || (config.interception.buyNow && matches(t, BUY_NOW)) || matches(t, CART_OPENERS) || genericCheckout(t)) warm();
  }
  document.addEventListener("pointerover", onIntent, { capture: true, passive: true });
  document.addEventListener("touchstart", onIntent, { capture: true, passive: true });
  document.addEventListener("focusin", onIntent, true);

  /* ---------------------------------------------------------------- */
  /* Debug overlay: ?whopco_debug=1                                    */
  /* ---------------------------------------------------------------- */

  function highlight() {
    var sel = checkoutSelectors().concat(config.interception.buyNow ? BUY_NOW : []);
    sel.forEach(function (s) {
      try {
        document.querySelectorAll(s).forEach(function (el) {
          el.style.outline = "3px solid #16a34a";
          el.style.outlineOffset = "2px";
          el.setAttribute("title", "Intercepté par Whop Checkout ✓");
        });
      } catch (e) {}
    });
  }

  function badge(text, ok) {
    var b = document.createElement("div");
    b.textContent = text;
    b.style.cssText =
      "position:fixed;bottom:16px;left:16px;z-index:2147483647;padding:8px 12px;border-radius:999px;font:600 13px system-ui,sans-serif;color:#fff;background:" +
      (ok ? "#16a34a" : "#dc2626");
    document.body.appendChild(b);
  }

  /* ---------------------------------------------------------------- */
  /* Config                                                            */
  /* ---------------------------------------------------------------- */

  // A network error, an HTTP error or a broken answer is tried once more 1.5 s later: only a second
  // failure means our server can't be reached (the checkout is then tried with assumedConfig).
  function fetchConfig() {
    return fetch(API + "/api/public/stores/" + encodeURIComponent(STORE) + "/config").then(function (r) {
      if (!r.ok) throw new Error("config HTTP " + r.status);
      return r.json();
    });
  }
  var configRequest = fetchConfig().catch(function (err) {
    log("config failed, retrying:", err && err.message);
    return wait(1500).then(fetchConfig);
  });
  // A held click waits 8 s at most (a plain timer: AbortSignal.timeout is missing in older Safari).
  // Past that the checkout is tried with the default settings; the request keeps going and a late
  // config replaces them.
  var SLOW = {};
  Promise.race([configRequest, wait(8000, SLOW)])
    .then(function (c) {
      if (c !== SLOW) return c;
      log("config still loading after 8 s: the checkout is tried with the default settings");
      if (DEBUG) badge("Whop Checkout : réglages en retard (checkout tenté avec les réglages par défaut)", false);
      config = assumedConfig();
      configLoading = false;
      releaseWaiting();
      return configRequest;
    })
    .then(
      function (c) {
        // An answer without settings is an unknown store: the shop's own checkout.
        config = c && c.interception ? c : null;
        configLoading = false;
        // The store's own selectors, for the clicks of its next pages made before their config arrives.
        if (config) localSet("whopco_custom", String(config.interception.customSelectors || ""));
        releaseWaiting();
        log("config", c);
        if (!config) {
          if (DEBUG) badge("Whop Checkout : configuration introuvable", false);
          return;
        }
        if (c.enabled) pingCheckoutDomain();
        // Landing on the cart: warmed once the ping knows where the POST will go (3 s at most).
        if (c.enabled && CART_PAGE.test(location.pathname)) (domainPing || Promise.resolve()).then(warm);
        if (!DEBUG) return;
        if (!c.enabled) return badge("Whop Checkout : désactivé (checkout Shopify natif)", false);
        badge("Whop Checkout : interception active ✓", true);
        highlight();
        new MutationObserver(highlight).observe(document.body, { childList: true, subtree: true });
      },
      function (err) {
        // Our server's settings can't be read (twice): the checkout is tried anyway (assumedConfig).
        config = assumedConfig();
        configLoading = false;
        log("config failed:", err && err.message);
        if (DEBUG) badge("Whop Checkout : réglages injoignables (checkout tenté quand même)", false);
        releaseWaiting();
      }
    );
})();
