/*!
 * Whop Checkout — storefront loader.
 * Injected automatically on the shop via a Shopify ScriptTag (or pasted once in theme.liquid).
 * Replaces the Shopify checkout with the store's Whop checkout, following the
 * interception settings from the dashboard. When anything fails it steps aside and
 * lets the native Shopify checkout run.
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
  var bypass = false;
  var busy = false;

  function log() {
    if (DEBUG && window.console) console.log.apply(console, ["[whop-checkout]"].concat([].slice.call(arguments)));
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
    "a[href*='/checkout'][class*='checkout']",
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

  function customSelectors() {
    return (config.interception.customSelectors || "")
      .split(/[\n,]/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }

  function checkoutSelectors() {
    var i = config.interception;
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
      "position:fixed;inset:0;z-index:2147483647;background:rgba(255,255,255,.75);display:flex;align-items:center;justify-content:center;font:500 15px/1.4 system-ui,sans-serif;color:#111";
    el.innerHTML =
      '<div style="display:flex;gap:10px;align-items:center"><span style="width:18px;height:18px;border:2px solid #111;border-right-color:transparent;border-radius:50%;display:inline-block;animation:whopco-spin .8s linear infinite"></span>Redirection vers le paiement sécurisé…</div><style>@keyframes whopco-spin{to{transform:rotate(360deg)}}</style>';
    document.body.appendChild(el);
  }

  function nativeCheckout(items) {
    bypass = true;
    overlay(false);
    if (items && items.some(function (i) { return i.selling_plan; })) {
      // A subscription bought with "buy now": add it with its plan, then Shopify's checkout.
      fetch("/cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ items: items.map(function (i) { return { id: Number(i.variant_id), quantity: i.quantity, selling_plan: Number(i.selling_plan) }; }) }),
      }).finally(function () {
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

  function goToCheckout(items) {
    if (busy) return;
    busy = true;
    overlay(true);
    var cartPromise = items
      ? Promise.resolve({ items: items })
      : fetch("/cart.js", { credentials: "same-origin", headers: { Accept: "application/json" } }).then(function (r) {
          return r.json();
        });
    cartPromise
      .then(function (cart) {
        var cartItems = (cart.items || []).filter(function (i) {
          return i.quantity > 0;
        });
        if (!cartItems.length) throw new Error("empty cart");
        if (excluded(cartItems)) throw new Error("excluded product");
        // Subscriptions (selling plans) and gift cards stay on Shopify's checkout, whole cart.
        if (unsupported(cartItems)) throw new Error("subscription or gift card");
        return fetch(config.sessionEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            store: STORE,
            items: cartItems.map(function (i) {
              var item = { variant_id: i.variant_id || i.id, quantity: i.quantity };
              var plan = sellingPlan(i);
              if (plan) item.selling_plan = plan;
              if (i.gift_card === true) item.gift_card = true;
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
          }),
        });
      })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok || !body.url) throw new Error(body.error || "session failed");
          keepVisitorId(body.visitorId);
          log("redirect", body.url);
          try {
            sessionStorage.setItem("whopco_pending", "1");
          } catch (e) {}
          location.href = body.url;
        });
      })
      .catch(function (err) {
        log("fallback to Shopify checkout:", err && err.message);
        busy = false;
        nativeCheckout(items);
      });
  }

  function productFormItems(el) {
    var form =
      (el.closest && el.closest("form[action*='/cart/add']")) ||
      (el.closest && el.closest("product-form, .product-form, [data-product-form]") &&
        el.closest("product-form, .product-form, [data-product-form]").querySelector("form[action*='/cart/add']")) ||
      document.querySelector("form[action*='/cart/add']");
    if (!form) return null;
    var fd = new FormData(form);
    var id = fd.get("id");
    if (!id) return null;
    var qty = parseInt(fd.get("quantity") || "1", 10) || 1;
    var item = { variant_id: String(id), quantity: qty, handle: location.pathname.split("/products/")[1] || "" };
    var plan = fd.get("selling_plan");
    if (plan) item.selling_plan = String(plan);
    return [item];
  }

  /* ---------------------------------------------------------------- */
  /* Listeners (capture phase, before the theme's own handlers)        */
  /* ---------------------------------------------------------------- */

  function onClick(e) {
    if (bypass || !config || !config.enabled) return;
    var t = e.target;
    if (!(t instanceof Element)) return;

    if (config.interception.buyNow && matches(t, BUY_NOW)) {
      var items = productFormItems(t);
      if (items) {
        e.preventDefault();
        e.stopImmediatePropagation();
        goToCheckout(items);
      }
      return;
    }
    if (matches(t, checkoutSelectors())) {
      e.preventDefault();
      e.stopImmediatePropagation();
      goToCheckout(null);
    }
  }

  function onSubmit(e) {
    if (bypass || !config || !config.enabled) return;
    var form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    var action = form.getAttribute("action") || "";
    var submitter = e.submitter;

    // Cart form submitted through its "checkout" button.
    if (
      (config.interception.cartCheckout || config.interception.cartDrawer) &&
      (/\/checkout/.test(action) || (/\/cart\/?$/.test(action) && submitter && submitter.name === "checkout"))
    ) {
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
          overlay(false);
          bypass = true;
          form.submit();
        });
    }
  }

  document.addEventListener("click", onClick, true);
  document.addEventListener("submit", onSubmit, true);

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

  fetch(API + "/api/public/stores/" + encodeURIComponent(STORE) + "/config")
    .then(function (r) {
      return r.json();
    })
    .then(function (c) {
      config = c;
      log("config", c);
      if (!DEBUG) return;
      if (!c.enabled) return badge("Whop Checkout : désactivé (checkout Shopify natif)", false);
      badge("Whop Checkout : interception active ✓", true);
      highlight();
      new MutationObserver(highlight).observe(document.body, { childList: true, subtree: true });
    })
    .catch(function () {
      config = null; // native checkout
    });
})();
