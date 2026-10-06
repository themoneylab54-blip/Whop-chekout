// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createElement as h } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

/*
 * Shopify reconnection robustness (pure parts): the form's domain handling, the secret field that
 * browsers cannot autofill, the secret sanity hint, the webhook signature, and the live status
 * check (token valid? loader present?) with Shopify mocked: ok / revoked / script missing / timeout.
 */

const { resolveShopDomainInput, clientSecretHint, hmacMismatchError, normalizeShopDomain, MIN_CLIENT_SECRET_LENGTH } = await import("@/lib/shopify-connect");
const { verifyWebhookHmac, loaderUrl } = await import("@/lib/shopify");
const { encrypt } = await import("@/lib/crypto");
const { shopifyLiveState, clearShopifyStatus, STATUS_TIMEOUT_MS } = await import("@/lib/shopify-status");
const { ShopifyConnectFields, SECRET_FIELD_ATTRS } = await import("@/components/dashboard/ShopifyConnectFields");

describe("form domain handling", () => {
  const known = { shopDomain: "27vmem-y1.myshopify.com", storefrontHost: "colandcie.com" };

  it("a .myshopify.com address or its handle is used as is", () => {
    expect(resolveShopDomainInput("27vmem-y1.myshopify.com", known)).toEqual({ ok: true, shop: "27vmem-y1.myshopify.com" });
    expect(resolveShopDomainInput("https://Other-Shop.myshopify.com/admin", known)).toEqual({ ok: true, shop: "other-shop.myshopify.com" });
    expect(resolveShopDomainInput("ma-boutique", {})).toEqual({ ok: true, shop: "ma-boutique.myshopify.com" });
    expect(normalizeShopDomain("x.myshopify.com.evil.com")).toBeNull();
  });

  it("the storefront domain maps to the known .myshopify.com address, with a notice", () => {
    for (const typed of ["colandcie.com", "https://www.colandcie.com/", "COLANDCIE.COM"]) {
      const r = resolveShopDomainInput(typed, known);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.shop).toBe("27vmem-y1.myshopify.com");
        expect(r.notice).toMatch(/domaine de votre vitrine.*27vmem-y1\.myshopify\.com/);
      }
    }
    // Another public domain: the known shop too, said differently.
    const other = resolveShopDomainInput("autre-site.fr", known);
    expect(other).toMatchObject({ ok: true, shop: "27vmem-y1.myshopify.com" });
    if (other.ok) expect(other.notice).toMatch(/n'est pas une adresse \.myshopify\.com/);
  });

  it("without a known shop, a public domain is explained, not just « invalide »", () => {
    const r = resolveShopDomainInput("colandcie.com", { shopDomain: null, storefrontHost: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/colandcie\.com est le domaine de votre vitrine.*\.myshopify\.com.*Paramètres → Domaines/);
    expect(resolveShopDomainInput("pas un domaine !", {})).toMatchObject({ ok: false, error: expect.stringMatching(/^Domaine invalide/) });
  });
});

describe("client secret hint and messages", () => {
  it("short values are refused, borderline ones warned, real ones pass", () => {
    expect(clientSecretHint("")).toBeNull();
    expect(clientSecretHint("MonMotDePasse1")).toMatchObject({ level: "error", message: expect.stringMatching(/^Ce n'est pas un Client secret Shopify/) });
    expect("x".repeat(MIN_CLIENT_SECRET_LENGTH - 1).length).toBeLessThan(16);
    expect(clientSecretHint("a".repeat(17))).toMatchObject({ level: "warn" });
    expect(clientSecretHint(`shpss_${"0123456789abcdef".repeat(2)}`)).toBeNull();
  });

  it("the HMAC error says what to do and, when connected, that nothing changed", () => {
    expect(hmacMismatchError(true)).toBe(
      "Le Client secret ne correspond pas au Client ID : copiez les deux depuis la même app Shopify (Dev Dashboard → votre app → Settings). Votre connexion actuelle n'a pas été modifiée.",
    );
    expect(hmacMismatchError(false)).not.toMatch(/connexion actuelle/);
  });
});

describe("secret field is autofill-proof", () => {
  afterEach(cleanup);
  const props = { defaultShop: "27vmem-y1.myshopify.com", knownShopDomain: "27vmem-y1.myshopify.com", storefrontHost: "colandcie.com", activeClientId: "abc123", hasStoredSecret: true };

  it("a masked text field (never a password field) that password managers ignore", () => {
    const { container } = render(h(ShopifyConnectFields, props));
    const input = container.querySelector<HTMLInputElement>("#clientSecret")!;
    expect(input.type).toBe("text");
    expect(input.name).toBe("clientSecret");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.hasAttribute("data-1p-ignore")).toBe(true);
    expect(input.getAttribute("data-lpignore")).toBe("true");
    expect(input.getAttribute("data-form-type")).toBe("other");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(input.className).toContain("[-webkit-text-security:disc]");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    // Not kept in the session draft of the form.
    expect(input.closest("[data-no-draft]")).not.toBeNull();
    expect(SECRET_FIELD_ATTRS.type).toBe("text");
    // The show toggle unmasks it.
    fireEvent.click(container.querySelector('button[aria-label="Afficher le Client secret"]')!);
    expect(input.className).not.toContain("[-webkit-text-security:disc]");
  });

  it("blank keeps the stored secret only for the same Client ID; a short value blocks the submit", () => {
    const { container, getByTestId } = render(h(ShopifyConnectFields, props));
    const input = container.querySelector<HTMLInputElement>("#clientSecret")!;
    expect(input.required).toBe(false);
    fireEvent.change(container.querySelector("#clientId")!, { target: { value: "other-app" } });
    expect(input.required).toBe(true);
    fireEvent.change(input, { target: { value: "motdepasse" } });
    expect(getByTestId("secret-hint").textContent).toMatch(/Ce n'est pas un Client secret Shopify/);
    expect(input.validity.customError).toBe(true);
  });

  it("after a signature failure, the stored secret is not offered again", () => {
    const { container } = render(h(ShopifyConnectFields, { ...props, secretMismatch: true }));
    expect(container.textContent).toContain("Recopiez le Client secret : celui enregistré ne correspond pas.");
    expect(container.textContent).not.toContain("Laissez vide");
    expect(container.querySelector<HTMLInputElement>("#clientSecret")!.required).toBe(true);
  });

  it("an abandoned first attempt prefills the shop and Client ID", () => {
    const { container } = render(h(ShopifyConnectFields, { ...props, knownShopDomain: null, activeClientId: null, hasStoredSecret: false, defaultShop: "pending-shop.myshopify.com", defaultClientId: "pending-app" }));
    expect(container.querySelector<HTMLInputElement>("#shopDomain")!.value).toBe("pending-shop.myshopify.com");
    expect(container.querySelector<HTMLInputElement>("#clientId")!.value).toBe("pending-app");
  });

  it("the helper text keeps the .myshopify.com address; the storefront domain gets a notice", () => {
    const { container, getByTestId } = render(h(ShopifyConnectFields, props));
    expect(container.textContent).toContain("Gardez l'adresse xxx.myshopify.com");
    expect(container.textContent).toContain("(colandcie.com) est détecté automatiquement");
    fireEvent.change(container.querySelector("#shopDomain")!, { target: { value: "colandcie.com" } });
    expect(getByTestId("shop-notice").textContent).toContain("27vmem-y1.myshopify.com");
  });
});

describe("webhook signature", () => {
  it("base64 HMAC-SHA256 of the raw body with the client secret", () => {
    const body = JSON.stringify({ id: 1, domain: "x.myshopify.com" });
    const sig = createHmac("sha256", "secret").update(body).digest("base64");
    expect(verifyWebhookHmac(body, sig, "secret")).toBe(true);
    expect(verifyWebhookHmac(body, sig, "other")).toBe(false);
    expect(verifyWebhookHmac(`${body} `, sig, "secret")).toBe(false);
    expect(verifyWebhookHmac(body, null, "secret")).toBe(false);
  });
});

describe("live status (Shopify mocked)", () => {
  const store = { id: "st_live", publicId: "pub_live", shopDomain: "live.myshopify.com", shopifyAccessToken: encrypt("tok") };
  const fetchMock = vi.fn();
  beforeEach(() => {
    clearShopifyStatus(store.id);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const answer = (nodes: { src: string }[]) => new Response(JSON.stringify({ data: { shop: { name: "Live" }, scriptTags: { nodes } } }), { status: 200 });

  it("token valid and loader present → active (then cached 60 s)", async () => {
    fetchMock.mockResolvedValue(answer([{ src: loaderUrl(store.publicId) }]));
    expect(await shopifyLiveState(store, { now: 1_000 })).toBe("active");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://live.myshopify.com/admin/api/2026-07/graphql.json");
    expect((init as RequestInit).headers).toMatchObject({ "X-Shopify-Access-Token": "tok" });
    expect(await shopifyLiveState(store, { now: 30_000 })).toBe("active");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(answer([]));
    expect(await shopifyLiveState(store, { now: 62_000 })).toBe("script_missing");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("loader absent (another src only) → script_missing", async () => {
    fetchMock.mockResolvedValue(answer([{ src: "https://elsewhere.example/loader.js" }]));
    expect(await shopifyLiveState(store)).toBe("script_missing");
  });

  it("401 → revoked", async () => {
    fetchMock.mockResolvedValue(new Response("[API] Invalid API key or access token", { status: 401 }));
    expect(await shopifyLiveState(store)).toBe("revoked");
  });

  it("no token → revoked without asking Shopify", async () => {
    expect(await shopifyLiveState({ ...store, shopifyAccessToken: null })).toBe("revoked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("slow Shopify → unknown after the 3 s timeout, not cached", async () => {
    expect(STATUS_TIMEOUT_MS).toBe(3_000);
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal!;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    });
    const started = Date.now();
    expect(await shopifyLiveState(store)).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(4_500);
    fetchMock.mockResolvedValue(answer([{ src: loaderUrl(store.publicId) }]));
    expect(await shopifyLiveState(store)).toBe("active");
  }, 10_000);

  it("5xx → unknown", async () => {
    fetchMock.mockResolvedValue(new Response("oops", { status: 503 }));
    expect(await shopifyLiveState(store)).toBe("unknown");
  });
});

describe("Shopify page shows the live state, streamed", () => {
  it("the four states and their actions, behind Suspense", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${process.cwd()}/src/app/dashboard/stores/[storeId]/(main)/shopify/page.tsx`, "utf8");
    expect(src).toContain("<Suspense");
    expect(src).toContain("shopifyLiveState(store)");
    for (const text of ["Script actif sur la boutique", "Script absent de la boutique", "Réinstaller le script", "Accès Shopify révoqué", "Reconnecter", "État inconnu"]) expect(src).toContain(text);
    expect(src).toContain('name="from" value="shopify"');
    // Checkout off while connected: a banner; the hmac failure and the pending shop reach the form.
    expect(src).toMatch(/connected && !store\.enabled[\s\S]*Checkout désactivé : vos clients passent par le checkout Shopify/);
    expect(src).toContain('secretMismatch={sp.reason === "hmac"}');
    expect(src).toContain("store.shopDomain ?? store.shopifyPendingShopDomain");
    // The old database-only claim is gone.
    expect(src).not.toContain("Script d'interception installé sur la boutique");
  });
});
