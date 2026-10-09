// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * Storefront loader, a theme's own buttons, links and forms: a checkout button is recognised by its
 * whole label (a price after it aside) and only in the cart (a container below <body>, or the cart
 * form's own button), never a promo code's « Valider », an upsell's « Acheter », « Payer en 3 fois »,
 * a sticky « Acheter maintenant » or a menu's « Commander »; only links and forms going to this shop's
 * checkout count; a cart permalink (/cart/111:2,222:1) is a « buy now » of its items.
 */

const API = "https://app.example.com";
const source = readFileSync(join(process.cwd(), "public/loader.js"), "utf8");

vi.useFakeTimers();
afterAll(() => {
  vi.useRealTimers();
});
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

const posts: { items?: { variant_id: string | number; quantity: number }[] }[] = [];

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/config")) {
      return new Response(JSON.stringify({ enabled: true, interception: { cartCheckout: true, cartDrawer: true, buyNow: true, customSelectors: "", excludedHandles: [] }, sessionEndpoint: `${API}/api/public/sessions` }));
    }
    if (u === "/cart.js") return new Response(JSON.stringify({ token: "cart-token-1", items: [{ variant_id: 1, quantity: 1, handle: "jacket" }] }));
    if (u.endsWith("/api/public/sessions") && init?.body !== '{"warm":true}') {
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: "x", reason: "price_higher" }), { status: 409 });
    }
    return new Response("{}");
  }),
);

document.body.className = "cart-open";
document.body.innerHTML = `
  <script src="${API}/loader.js?store=st_1"></script>
  <header><nav class="mega-menu"><button type="button" id="menu-commander">Commander</button></nav></header>
  <div class="page"><button type="button" id="pay-outside">Paiement</button></div>
  <div class="js-cartography"><button type="button" id="pay-cartography">Paiement</button></div>
  <cart-drawer>
    <div class="upsell"><button type="button" id="upsell-buy">Acheter</button></div>
    <div class="discount"><input name="discount" placeholder="Code promo"><button type="button" id="promo-ok">Valider</button></div>
    <div class="field"><input name="coupon"><button type="button" id="promo-commander">Commander</button></div>
    <div class="gift-note"><textarea name="note"></textarea><button type="button" id="note-ok">Valider</button></div>
    <div class="footer">
      <div class="discount-block"><input name="discount"></div>
      <p><button type="button" id="pay-later">Payer en 3 fois</button></p>
      <button type="button" id="drawer-pay">Passer la commande • 49,00 €</button>
      <button type="button" id="price-pay">Paiement 49,00 €</button>
    </div>
  </cart-drawer>
  <div id="CartDrawer"><button type="button" id="camel-pay">Checkout - $49.00</button></div>
  <form action="/cart/add" id="product-form-1"><input type="hidden" name="id" value="111"></form>
  <form action="/cart/add" id="product-form-2"><input type="hidden" name="id" value="222"></form>
  <div class="sticky-bar"><button type="submit" form="product-form-1" id="sticky-buy">Acheter maintenant</button></div>
  <div class="sticky-add-to-cart"><button type="button" form="product-form-1" id="sticky-order">Commander</button></div>
  <div class="shopify-payment-button"><button type="button" class="shopify-payment-button__button" id="orphan-buy">Buy it now</button></div>
  <form action="/fr/cart" method="post" id="cart"></form>
  <div class="summary"><button type="button" form="cart" id="form-owned">Paiement</button></div>
  <a href="https://partner.example.net/checkout" id="foreign-link">Our partner</a>
  <a href="https://partner.example.net/checkout" class="checkout-button" id="foreign-class-link">Partner</a>
  <a href="/pages/checkout-help" id="help-link">Help</a>
  <a href="/fr/checkout" id="locale-link">Go</a>
  <a href="${location.origin}/checkouts/cn/abc" id="absolute-link">Go</a>
  <a href="/cart/111:2,222:1" id="permalink">Buy the bundle</a>
  <a href="https://partner.example.net/cart/111:1" id="foreign-permalink">Partner bundle</a>
  <form action="/fr/checkout" id="checkout-form"><button type="submit" id="checkout-submit">Go</button></form>
  <div class="upcart-drawer"><button type="button" id="upcart-pay">🔒 Paiement sécurisé</button></div>
  <div id="sidecart"><button type="button" id="sidecart-now">Commander maintenant</button></div>
  <div class="minicart"><button type="button" id="minicart-caisse">Passer à la caisse</button></div>
  <div class="cart-footer"><input name="discount"><button type="button" id="checkout-beside-code">Checkout ✓</button></div>
  <div class="shopify-section" id="shopify-section-main">
    <form action="/cart/add" id="pf-section"><input type="hidden" name="id" value="333"></form>
    <div class="shopify-payment-button"><button type="button" class="shopify-payment-button__button" id="section-buy">Buy it now</button></div>
  </div>
  <a href="/cart/111:1?storefront=true" id="storefront-permalink">Add the bundle</a>
  <form action="/cart" id="cart-js-form"><input type="hidden" name="checkout" value="1"></form>
  <form action="https://partner.example.net/checkout" id="foreign-form"><button type="submit" id="foreign-submit">Go</button></form>`;
new Function(source)();

// The theme's own handling (after ours): what reached it wasn't intercepted.
const theme: string[] = [];
document.addEventListener("click", (e) => {
  theme.push((e.target as Element).id);
  if ((e.target as Element).closest("a")) e.preventDefault(); // no jsdom navigation
});
const themeSubmits: string[] = [];
document.addEventListener("submit", (e) => {
  themeSubmits.push((e.target as Element).id);
  e.preventDefault(); // the theme's own (AJAX) handling, no jsdom navigation
});

const click = (id: string) => {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  document.getElementById(id)!.dispatchEvent(ev);
  return ev;
};
const closeError = () => document.getElementById("whopco-error")?.remove();
// Ours: our checkout asked (a session request), the theme never got the click.
const expectOurs = async (id: string) => {
  const before = posts.length;
  expect(click(id).defaultPrevented, id).toBe(true);
  await settle();
  expect(posts.length, id).toBe(before + 1);
  expect(theme, id).not.toContain(id);
  closeError();
};
const expectTheirs = async (id: string) => {
  const before = posts.length;
  click(id);
  await settle();
  expect(posts.length, id).toBe(before);
  expect(theme, id).toContain(id);
};

describe("loader: a theme's checkout buttons", () => {
  it("false friends aren't checkouts: promo code, upsell, « Payer en 3 fois », sticky add-to-cart buttons, a menu, the page's body class", async () => {
    await settle(); // config loaded
    // « Commander » in a sticky add-to-cart bar (a « cart » class) is the product form's own (form=…).
    for (const id of ["promo-ok", "promo-commander", "note-ok", "upsell-buy", "pay-later", "sticky-buy", "sticky-order", "pay-outside", "pay-cartography"]) await expectTheirs(id);
    // The sticky button's own submission (its product form) isn't ours either.
    expect(themeSubmits).toEqual(["product-form-1"]);
    // Even on the cart page, a « Commander » outside the cart.
    history.pushState(null, "", "/fr/cart");
    await expectTheirs("menu-commander");
    history.pushState(null, "", "/");
  });

  it("the cart's own buttons are: « Passer la commande • 49,00 € » and « Paiement 49,00 € » in the drawer, « Checkout - $49.00 » in #CartDrawer, « Paiement » tied to the cart form", async () => {
    for (const id of ["drawer-pay", "price-pay", "camel-pay", "form-owned"]) await expectOurs(id);
  });

  it("a « buy now » outside any product form isn't guessed among the page's several forms", async () => {
    await expectTheirs("orphan-buy");
  });

  it("cart-drawer apps' buttons are ours: « 🔒 Paiement sécurisé » in an UpCart drawer, « Commander maintenant » in #sidecart, « Passer à la caisse » in a minicart, « Checkout ✓ » beside a code field", async () => {
    for (const id of ["upcart-pay", "sidecart-now", "minicart-caisse", "checkout-beside-code"]) await expectOurs(id);
  });

  it("a « buy now » outside its form: its section's only product form, else the product page's selected variant", async () => {
    await expectOurs("section-buy");
    expect(posts.at(-1)?.items).toEqual([expect.objectContaining({ variant_id: "333", quantity: 1 })]);
    // (The same orphan button went to the theme on the home page above: it's ours on a product page.)
    history.pushState(null, "", "/products/jacket?variant=444");
    const before = posts.length;
    expect(click("orphan-buy").defaultPrevented).toBe(true);
    await settle();
    expect(posts.length).toBe(before + 1);
    expect(posts.at(-1)?.items).toEqual([expect.objectContaining({ variant_id: "444", quantity: 1 })]);
    closeError();
    history.pushState(null, "", "/");
  });
});

describe("loader: links and forms", () => {
  it("a permalink with ?storefront=true only fills the cart: the theme's", async () => {
    await expectTheirs("storefront-permalink");
  });

  it("the cart form sent by the theme's script, its hidden « checkout » field set, is ours", async () => {
    const before = posts.length;
    (document.getElementById("cart-js-form") as HTMLFormElement).requestSubmit();
    await settle();
    expect(posts.length).toBe(before + 1);
    expect(themeSubmits).not.toContain("cart-js-form");
    closeError();
  });

  it("only this shop's checkout: not another site's /checkout (a « checkout » class or not), nor a page named checkout", async () => {
    for (const id of ["foreign-link", "foreign-class-link", "help-link"]) await expectTheirs(id);
    for (const id of ["locale-link", "absolute-link"]) await expectOurs(id);
  });

  it("a form posting to this shop's checkout is ours (same path test), another site's isn't", async () => {
    const before = posts.length;
    click("checkout-submit");
    await settle();
    expect(posts.length).toBe(before + 1);
    expect(themeSubmits).not.toContain("checkout-form");
    closeError();
    click("foreign-submit");
    await settle();
    expect(posts.length).toBe(before + 1);
    expect(themeSubmits).toContain("foreign-form");
  });

  it("a cart permalink (/cart/111:2,222:1) is a « buy now » of its items; another site's isn't", async () => {
    await expectOurs("permalink");
    expect(posts[posts.length - 1].items).toEqual([
      { variant_id: "111", quantity: 2 },
      { variant_id: "222", quantity: 1 },
    ]);
    await expectTheirs("foreign-permalink");
  });
});
