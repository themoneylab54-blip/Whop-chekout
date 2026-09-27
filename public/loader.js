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

  function utm() {
    var out = {};
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid", "ttclid"].forEach(function (k) {
      var v = params.get(k) || sessionStorageGet("whopco_" + k);
      if (v) out[k] = v.slice(0, 300);
    });
    return out;
  }
  function sessionStorageGet(k) {
    try {
      return sessionStorage.getItem(k);
    } catch (e) {
      return null;
    }
  }
  (function rememberUtm() {
    try {
      params.forEach(function (v, k) {
        if (/^(utm_|fbclid|gclid|ttclid)/.test(k)) sessionStorage.setItem("whopco_" + k, v);
      });
    } catch (e) {}
  })();

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
    if (items) {
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
        return fetch(config.sessionEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            store: STORE,
            items: cartItems.map(function (i) {
              return { variant_id: i.variant_id || i.id, quantity: i.quantity };
            }),
            returnUrl: location.origin + "/",
            utm: utm(),
          }),
        });
      })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok || !body.url) throw new Error(body.error || "session failed");
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
    return [{ variant_id: String(id), quantity: qty, handle: location.pathname.split("/products/")[1] || "" }];
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
