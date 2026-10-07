import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Express PayPal button: the PayPal-only Whop checkout (createCheckoutConfiguration's `methods`
 * override, Whop SDK mocked), the `paypal` availability flag, and the buyer-facing labels in
 * every checkout language.
 */

const sdk = vi.hoisted(() => ({ create: vi.fn() }));
const store = vi.hoisted(() => ({ settings: new Map<string, string>() }));

vi.mock("@whop/sdk", () => ({
  WhopEnvironment: { Sandbox: "sandbox", Production: "production" },
  WhopClient: class {
    checkoutConfigurations = { create: sdk.create };
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    appSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => (store.settings.has(where.key) ? { key: where.key, value: store.settings.get(where.key) } : null)),
      upsert: vi.fn(async ({ where, create }: { where: { key: string }; create: { value: string } }) => store.settings.set(where.key, create.value)),
    },
  },
}));
vi.mock("@/lib/log", async (orig) => ({ ...(await orig<typeof import("@/lib/log")>()), recordEvent: vi.fn() }));

const { createCheckoutConfiguration, MethodUnavailableError } = await import("@/lib/whop");
const { encrypt } = await import("@/lib/crypto");
const { LABELS, errorText } = await import("@/components/checkout/i18n");

const whopStore = { whopApiKey: encrypt("k"), testMode: true, whopAccountId: "biz_pp", whopProductId: "prod_pp", paymentMethods: ["klarna"] };
const opts = { sessionId: "pp_session", storeId: "pp_store", totalCents: 4990, currency: "EUR", title: "Commande pp_", redirectUrl: "https://x.test/merci", country: "FR" };
const config = (enabled: string[] | null, id = "ch_pp_1") => ({
  id,
  purchase_url: null,
  effective_payment_method_configuration: enabled ? { enabled, disabled: [], include_platform_defaults: false } : null,
});

describe("createCheckoutConfiguration: methods override", () => {
  beforeEach(() => {
    sdk.create.mockReset();
    store.settings.clear();
  });

  it("creates a PayPal-only checkout with the regular plan and metadata (no platform defaults)", async () => {
    sdk.create.mockResolvedValueOnce(config(["paypal"], "ch_pp_paypal"));
    const res = await createCheckoutConfiguration(whopStore, { ...opts, methods: ["paypal"] });
    expect(res).toEqual({ id: "ch_pp_paypal", purchaseUrl: null, paypal: true });
    expect(sdk.create).toHaveBeenCalledTimes(1);
    const params = sdk.create.mock.calls[0][0];
    expect(params.payment_method_configuration).toEqual({ enabled: ["paypal"], disabled: [], include_platform_defaults: false });
    // Identical to the regular checkout: webhooks, markPaid and reconciliation see no difference.
    expect(params.metadata).toEqual({ checkout_session_id: "pp_session", store_id: "pp_store" });
    expect(params.plan).toMatchObject({ product_id: "prod_pp", initial_price: 49.9, currency: "eur", metadata: { checkout_session_id: "pp_session" } });

    sdk.create.mockResolvedValueOnce(config(["card", "paypal", "apple_pay"], "ch_pp_regular"));
    await createCheckoutConfiguration(whopStore, opts);
    const regular = sdk.create.mock.calls[1][0];
    expect({ ...regular, payment_method_configuration: undefined }).toEqual({ ...params, payment_method_configuration: undefined });
    expect(regular.payment_method_configuration.include_platform_defaults).toBe(true);
    expect(regular.payment_method_configuration.enabled).toContain("klarna");
  });

  it("never falls back to other methods: refused or dropped PayPal throws MethodUnavailableError", async () => {
    sdk.create.mockRejectedValueOnce(Object.assign(new Error("paypal not enabled"), { statusCode: 422 }));
    await expect(createCheckoutConfiguration(whopStore, { ...opts, methods: ["paypal"] })).rejects.toBeInstanceOf(MethodUnavailableError);
    expect(sdk.create).toHaveBeenCalledTimes(1);
    sdk.create.mockRejectedValueOnce(Object.assign(new Error("bad request"), { statusCode: 400 }));
    await expect(createCheckoutConfiguration(whopStore, { ...opts, methods: ["paypal"] })).rejects.toBeInstanceOf(MethodUnavailableError);

    sdk.create.mockResolvedValueOnce(config(["card"]));
    await expect(createCheckoutConfiguration(whopStore, { ...opts, methods: ["paypal"] })).rejects.toMatchObject({ methods: ["paypal"], remember: true });
  });

  it("remembers a refusal only when Whop's error names PayPal or the payment method", async () => {
    const refused = async (err: unknown) => {
      sdk.create.mockRejectedValueOnce(err);
      return createCheckoutConfiguration(whopStore, { ...opts, methods: ["paypal"] }).catch((e) => e);
    };
    for (const err of [
      Object.assign(new Error("paypal not enabled"), { statusCode: 422 }),
      Object.assign(new Error("400 Bad Request"), { statusCode: 400, error: { error: { code: "invalid_payment_method", message: "Not available" } } }),
      Object.assign(new Error("Unprocessable"), { status: 422, code: "payment_method_unavailable" }),
      Object.assign(new Error("Payment method configuration is invalid"), { statusCode: 400 }),
    ]) {
      const got = await refused(err);
      expect(got, err.message).toBeInstanceOf(MethodUnavailableError);
      expect(got.remember, err.message).toBe(true);
    }
    for (const err of [
      Object.assign(new Error("bad request"), { statusCode: 400 }),
      Object.assign(new Error("400 Bad Request"), { statusCode: 400, error: { error: { code: "invalid_price", message: "initial_price too low" } } }),
      Object.assign(new Error("Plan title too long"), { status: 422 }),
    ]) {
      const got = await refused(err);
      expect(got, err.message).toBeInstanceOf(MethodUnavailableError);
      expect(got.remember, err.message).toBe(false);
    }
  });

  it("a transient Whop failure (5xx, 429, timeout, network) is rethrown as is, never as 'PayPal unavailable'", async () => {
    for (const err of [
      Object.assign(new Error("Internal Server Error"), { statusCode: 500 }),
      Object.assign(new Error("Service Unavailable"), { statusCode: 503 }),
      Object.assign(new Error("Too Many Requests"), { statusCode: 429 }),
      Object.assign(new Error("Unauthorized"), { statusCode: 401 }),
      new Error("fetch failed"),
      Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }),
    ]) {
      sdk.create.mockRejectedValueOnce(err);
      const got = await createCheckoutConfiguration(whopStore, { ...opts, methods: ["paypal"] }).catch((e) => e);
      expect(got, err.message).toBe(err);
      expect(got).not.toBeInstanceOf(MethodUnavailableError);
    }
  });

  it("a PayPal-only checkout Whop accepted without saying what it enabled: PayPal unknown (null)", async () => {
    sdk.create.mockResolvedValueOnce(config(null, "ch_pp_silent"));
    expect(await createCheckoutConfiguration(whopStore, { ...opts, methods: ["paypal"] })).toEqual({ id: "ch_pp_silent", purchaseUrl: null, paypal: null });
  });

  it("reports whether the regular checkout offers PayPal", async () => {
    sdk.create.mockResolvedValueOnce(config(["card", "apple_pay"]));
    expect((await createCheckoutConfiguration(whopStore, opts)).paypal).toBe(false);
    sdk.create.mockResolvedValueOnce(config(["card", "paypal"]));
    expect((await createCheckoutConfiguration(whopStore, opts)).paypal).toBe(true);
    // Whop doesn't say what it enabled: PayPal unknown (null) — never remembered as "on".
    sdk.create.mockResolvedValueOnce(config(null));
    expect((await createCheckoutConfiguration(whopStore, opts)).paypal).toBeNull();
    // Every method list refused: the account's defaults, PayPal unknown as well.
    sdk.create.mockRejectedValueOnce(new Error("bad")).mockRejectedValueOnce(new Error("bad")).mockResolvedValueOnce(config(null));
    expect((await createCheckoutConfiguration(whopStore, opts)).paypal).toBeNull();
  });

  it("the account-defaults fallback (after errors) never reports PayPal 'off', only a confirmed 'on'", async () => {
    const transient = () => Object.assign(new Error("Service Unavailable"), { statusCode: 503 });
    // Both method lists fail transiently, the defaults leave PayPal out: unknown, not "off".
    sdk.create.mockRejectedValueOnce(transient()).mockRejectedValueOnce(transient()).mockResolvedValueOnce(config(["card"]));
    const res = await createCheckoutConfiguration(whopStore, opts);
    expect(res.paypal).toBeNull();
    expect(sdk.create.mock.calls[2][0].payment_method_configuration).toBeUndefined();
    // The defaults include PayPal: that is still a confirmed "on".
    sdk.create.mockRejectedValueOnce(transient()).mockRejectedValueOnce(transient()).mockResolvedValueOnce(config(["card", "paypal"]));
    expect((await createCheckoutConfiguration(whopStore, opts)).paypal).toBe(true);
    // Only the optional-method list failed: the second (PayPal-requesting) list answered, so "off" stands.
    sdk.create.mockRejectedValueOnce(Object.assign(new Error("klarna"), { statusCode: 422 })).mockResolvedValueOnce(config(["card"]));
    expect((await createCheckoutConfiguration(whopStore, opts)).paypal).toBe(false);
  });
});

describe("express PayPal labels", () => {
  const keys = ["payWithPaypal", "paypalNeedsDetails", "paypalContinue", "paypalSelected", "paypalPayOther", "paypalPopupHint", "paypalUseWhopButton", "paypalExpressLocked", "paypalCheckFailed"] as const;
  it.each(Object.keys(LABELS))("%s has every PayPal label", (lang) => {
    const L = LABELS[lang as keyof typeof LABELS];
    for (const k of keys) {
      expect(typeof L[k], `${lang}.${k}`).toBe("string");
      expect((L[k] as string).trim().length, `${lang}.${k}`).toBeGreaterThan(0);
    }
    expect(L.payWithPaypal).toMatch(/PayPal/);
    expect(L.paypalNeedsDetails).toMatch(/PayPal/);
    expect(errorText(L, { code: "paypal_unavailable" })).toBe(L.errors.paypal_unavailable);
    expect(L.errors.paypal_unavailable).toMatch(/PayPal/);
  });
  it("covers the six checkout languages, with the French wording asked for", () => {
    expect(Object.keys(LABELS).sort()).toEqual(["de", "en", "es", "fr", "it", "nl"]);
    expect(LABELS.fr.paypalNeedsDetails).toBe("Renseignez vos coordonnées de livraison pour payer avec PayPal");
    expect(LABELS.fr.payWithPaypal).toBe("Payer avec PayPal");
    expect(LABELS.fr.paypalExpressLocked).toBe("Un paiement PayPal est ouvert. Choisissez « Payer autrement » pour changer.");
  });
});

describe("paypalWindowSettled", () => {
  it("stops polling on abort (panel unmounted) or after its time cap, leaving no timer behind", async () => {
    vi.useFakeTimers();
    try {
      const { paypalWindowSettled } = await import("@/components/checkout/Payment");
      const doc = { visibilityState: "hidden", hasFocus: () => false };
      vi.stubGlobal("document", doc);
      // The PayPal window keeps the focus: still polling well past the start delay.
      const ctrl = new AbortController();
      let settled = false;
      void paypalWindowSettled(ctrl.signal).then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(false);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      ctrl.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      // Never answers: resolved by the cap.
      let capped = false;
      void paypalWindowSettled(undefined, 60_000).then(() => (capped = true));
      await vi.advanceTimersByTimeAsync(59_000);
      expect(capped).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(capped).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      // Focus back on the page: resolved by the poll.
      let back: boolean | null = null;
      void paypalWindowSettled().then((opened) => (back = opened));
      await vi.advanceTimersByTimeAsync(2_000);
      Object.assign(doc, { visibilityState: "visible", hasFocus: () => true });
      await vi.advanceTimersByTimeAsync(400);
      // The focus did leave (a window opened): something may be pending.
      expect(back).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe("paypalWindowSettled: blocked popup", () => {
  it("answers false soon when the focus never leaves the page (nothing pending, no lock-out)", async () => {
    vi.useFakeTimers();
    try {
      const { paypalWindowSettled } = await import("@/components/checkout/Payment");
      vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => true });
      let opened: boolean | null = null;
      void paypalWindowSettled().then((o) => (opened = o));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(opened).toBeNull();
      await vi.advanceTimersByTimeAsync(800);
      expect(opened).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe("paypalWindowSettled: grace from the submit", () => {
  it("counts the blocked-window grace only once submit() is done (a slow submit is no blocked window)", async () => {
    vi.useFakeTimers();
    try {
      const { paypalWindowSettled } = await import("@/components/checkout/Payment");
      vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => true });
      let submitted!: () => void;
      const submit = new Promise<void>((r) => (submitted = r));
      let opened: boolean | null = null;
      void paypalWindowSettled(undefined, undefined, 2500, submit).then((o) => (opened = o));
      // submit() still running after 5 s: no verdict yet.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(opened).toBeNull();
      submitted();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(opened).toBeNull();
      await vi.advanceTimersByTimeAsync(800);
      expect(opened).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      // A failed submit starts the grace too (never polls for the whole cap).
      let failed: boolean | null = null;
      void paypalWindowSettled(undefined, undefined, 2500, Promise.reject(new Error("x"))).then((o) => (failed = o));
      await vi.advanceTimersByTimeAsync(2_800);
      expect(failed).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe("paypalWindowOpened", () => {
  it("resolves true once a window takes the focus after an interaction inside the embed, false on abort, leaving no timer", async () => {
    vi.useFakeTimers();
    try {
      const { paypalWindowOpened } = await import("@/components/checkout/Payment");
      const iframe = { tagName: "IFRAME" };
      const field = { tagName: "INPUT" };
      const box = { contains: (el: unknown) => el === iframe };
      const doc = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true, activeElement: field as unknown });
      const win = new EventTarget();
      vi.stubGlobal("document", doc);
      vi.stubGlobal("window", win);
      let opened: boolean | null = null;
      void paypalWindowOpened(new AbortController().signal, () => box as unknown as Element).then((o) => (opened = o));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(opened).toBeNull();
      // A mere tab switch (no interaction inside the embed): no PayPal window.
      Object.assign(doc, { visibilityState: "hidden", hasFocus: () => false });
      win.dispatchEvent(new Event("blur"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(opened).toBeNull();
      Object.assign(doc, { visibilityState: "visible", hasFocus: () => true });
      // A click inside the embed (the focus moves into its iframe as the window blurs), then a
      // field of the page again: disarmed.
      Object.assign(doc, { activeElement: iframe });
      win.dispatchEvent(new Event("blur"));
      await vi.advanceTimersByTimeAsync(0);
      Object.assign(doc, { activeElement: field });
      doc.dispatchEvent(new Event("focusin"));
      Object.assign(doc, { hasFocus: () => false });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(opened).toBeNull();
      // Click inside the embed, then its PayPal window takes the focus: opened.
      Object.assign(doc, { hasFocus: () => true, activeElement: iframe });
      win.dispatchEvent(new Event("blur"));
      await vi.advanceTimersByTimeAsync(200);
      expect(opened).toBeNull();
      Object.assign(doc, { hasFocus: () => false });
      await vi.advanceTimersByTimeAsync(200);
      expect(opened).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      // An iframe outside the embed (e.g. a wallet button) arms nothing.
      const other = { tagName: "IFRAME" };
      Object.assign(doc, { hasFocus: () => true, activeElement: other });
      let outside: boolean | null = null;
      const ctrl0 = new AbortController();
      void paypalWindowOpened(ctrl0.signal, () => box as unknown as Element).then((o) => (outside = o));
      win.dispatchEvent(new Event("blur"));
      Object.assign(doc, { hasFocus: () => false });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(outside).toBeNull();
      ctrl0.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(outside).toBe(false);
      const ctrl = new AbortController();
      let aborted: boolean | null = null;
      void paypalWindowOpened(ctrl.signal).then((o) => (aborted = o));
      ctrl.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe("pendingPollNext (background checks of a pending PayPal payment)", async () => {
  const { pendingPollNext, PENDING_POLL_MS, PENDING_POLL_HIDDEN_MS, PENDING_POLL_AFTER_CLOSE_MS, PAYPAL_WINDOW_MAX_MS } = await import("@/components/checkout/Payment");
  const startedAt = 5_000_000;

  it("polls every 4 s while visible, 15 s while the tab is hidden", () => {
    expect(pendingPollNext("unpaid", { now: startedAt + 4_000, startedAt, windowClosedAt: null, hidden: false })).toBe(PENDING_POLL_MS);
    expect(pendingPollNext("unpaid", { now: startedAt + 4_000, startedAt, windowClosedAt: null, hidden: true })).toBe(PENDING_POLL_HIDDEN_MS);
  });

  it("stops ~2 min after the window closed with the session unpaid, not while in flight or unknown", () => {
    const closed = startedAt + 60_000;
    expect(pendingPollNext("unpaid", { now: closed + PENDING_POLL_AFTER_CLOSE_MS - 1, startedAt, windowClosedAt: closed, hidden: false })).toBe(PENDING_POLL_MS);
    expect(pendingPollNext("unpaid", { now: closed + PENDING_POLL_AFTER_CLOSE_MS, startedAt, windowClosedAt: closed, hidden: false })).toBeNull();
    expect(pendingPollNext("inFlight", { now: closed + PENDING_POLL_AFTER_CLOSE_MS, startedAt, windowClosedAt: closed, hidden: false })).toBe(PENDING_POLL_MS);
    expect(pendingPollNext("unknown", { now: closed + PENDING_POLL_AFTER_CLOSE_MS, startedAt, windowClosedAt: closed, hidden: false })).toBe(PENDING_POLL_MS);
  });

  it("never polls forever: capped past the longest window watch, whatever the answers", () => {
    const cap = startedAt + PAYPAL_WINDOW_MAX_MS + PENDING_POLL_AFTER_CLOSE_MS;
    expect(pendingPollNext("unknown", { now: cap - 1, startedAt, windowClosedAt: null, hidden: true })).toBe(PENDING_POLL_HIDDEN_MS);
    expect(pendingPollNext("unknown", { now: cap, startedAt, windowClosedAt: null, hidden: true })).toBeNull();
    expect(pendingPollNext("inFlight", { now: cap, startedAt, windowClosedAt: null, hidden: false })).toBeNull();
  });
});

describe("paypalRetryStep (\"Continue with PayPal\" while a payment may be pending)", async () => {
  const { paypalRetryStep, PAYPAL_SERVER_IN_FLIGHT_MS, PAYPAL_AFTER_WINDOW_MS } = await import("@/components/checkout/Payment");
  const now = 9_000_000;

  it("paid: thank-you page; unpaid: submit", () => {
    expect(paypalRetryStep("paid", { now, lastSubmitAt: now - 1_000, windowClosedAt: null })).toBe("paid");
    expect(paypalRetryStep("unpaid", { now, lastSubmitAt: now - 1_000, windowClosedAt: now - 500 })).toBe("submit");
  });

  it("in flight or unknown: waits after a recent submit or a window just closed", () => {
    for (const state of ["inFlight", "unknown"] as const) {
      expect(paypalRetryStep(state, { now, lastSubmitAt: now - 5_000, windowClosedAt: now - 60_000 })).toBe("wait");
      expect(paypalRetryStep(state, { now, lastSubmitAt: now - PAYPAL_SERVER_IN_FLIGHT_MS, windowClosedAt: now - 1_000 })).toBe("wait");
      expect(paypalRetryStep(state, { now, lastSubmitAt: now - PAYPAL_SERVER_IN_FLIGHT_MS, windowClosedAt: null })).toBe("wait");
      // Submitted long ago, window closed long ago: this click's own confirm() is the "in flight".
      expect(paypalRetryStep(state, { now, lastSubmitAt: now - PAYPAL_SERVER_IN_FLIGHT_MS, windowClosedAt: now - PAYPAL_AFTER_WINDOW_MS })).toBe("submit");
    }
  });
});

describe("paypalStaysChosen (PayPal withdrawn while its payment is pending)", async () => {
  const { paypalStaysChosen } = await import("@/components/checkout/Payment");
  it("stays chosen while the panel is locked, dropped once it unlocks", () => {
    expect(paypalStaysChosen({ mode: true, offered: true, lock: null })).toBe(true);
    expect(paypalStaysChosen({ mode: true, offered: false, lock: "pending" })).toBe(true);
    expect(paypalStaysChosen({ mode: true, offered: false, lock: "busy" })).toBe(true);
    expect(paypalStaysChosen({ mode: true, offered: false, lock: null })).toBe(false);
    expect(paypalStaysChosen({ mode: false, offered: true, lock: "pending" })).toBe(false);
  });
});

describe("paypalLeaveStep (leaving a pending PayPal payment)", async () => {
  const { paypalLeaveStep, PAYPAL_CHECK_POLL_MS } = await import("@/components/checkout/Payment");
  const askedAt = 1_000_000;

  it("paid: straight to the thank-you page, whatever the timing", () => {
    expect(paypalLeaveStep("paid", { now: askedAt, askedAt, windowClosedAt: askedAt })).toEqual({ next: "paid" });
    expect(paypalLeaveStep("paid", { now: askedAt + 60_000, askedAt, windowClosedAt: null })).toEqual({ next: "paid" });
  });

  it("unpaid: switches only after 2.5 s, and ~10 s after the PayPal window closed", () => {
    // No window seen (e.g. pending from an earlier try): 2.5 s minimum, checked right at the boundary.
    expect(paypalLeaveStep("unpaid", { now: askedAt, askedAt, windowClosedAt: null })).toEqual({ next: "poll", inMs: PAYPAL_CHECK_POLL_MS });
    expect(paypalLeaveStep("unpaid", { now: askedAt + 2_000, askedAt, windowClosedAt: null })).toEqual({ next: "poll", inMs: 500 });
    expect(paypalLeaveStep("unpaid", { now: askedAt + 2_500, askedAt, windowClosedAt: null })).toEqual({ next: "switch" });
    // The window closed just before the answer: checks go on for ~10 s after it, even if the status
    // route no longer sees anything in flight (the Pay click was long ago).
    const closed = askedAt - 1_000;
    expect(paypalLeaveStep("unpaid", { now: askedAt + 3_000, askedAt, windowClosedAt: closed })).toEqual({ next: "poll", inMs: PAYPAL_CHECK_POLL_MS });
    expect(paypalLeaveStep("unpaid", { now: askedAt + 8_000, askedAt, windowClosedAt: closed })).toEqual({ next: "poll", inMs: 1_000 });
    expect(paypalLeaveStep("unpaid", { now: askedAt + 9_000, askedAt, windowClosedAt: closed })).toEqual({ next: "switch" });
    // Closed long before: only the 2.5 s minimum is left.
    expect(paypalLeaveStep("unpaid", { now: askedAt + 2_500, askedAt, windowClosedAt: askedAt - 60_000 })).toEqual({ next: "switch" });
  });

  it("in flight: keeps checking ~10 s, then waits (no switch under a payment going through)", () => {
    expect(paypalLeaveStep("inFlight", { now: askedAt + 3_000, askedAt, windowClosedAt: null })).toEqual({ next: "poll", inMs: PAYPAL_CHECK_POLL_MS });
    expect(paypalLeaveStep("inFlight", { now: askedAt + 9_000, askedAt, windowClosedAt: null })).toEqual({ next: "poll", inMs: 1_000 });
    expect(paypalLeaveStep("inFlight", { now: askedAt + 10_000, askedAt, windowClosedAt: null })).toEqual({ next: "wait" });
    // Window closed after the answer's reference point: the watch lasts until ~10 s after it.
    expect(paypalLeaveStep("inFlight", { now: askedAt + 10_000, askedAt, windowClosedAt: askedAt + 4_000 })).toEqual({ next: "poll", inMs: PAYPAL_CHECK_POLL_MS });
    expect(paypalLeaveStep("inFlight", { now: askedAt + 14_000, askedAt, windowClosedAt: askedAt + 4_000 })).toEqual({ next: "wait" });
  });

  it("a failed check (unknown) fails closed: waits like in flight, never switches, until ~2 min after the window closed", async () => {
    const { PENDING_POLL_AFTER_CLOSE_MS } = await import("@/components/checkout/Payment");
    expect(paypalLeaveStep("unknown", { now: askedAt + 3_000, askedAt, windowClosedAt: null })).toEqual({ next: "poll", inMs: PAYPAL_CHECK_POLL_MS });
    expect(paypalLeaveStep("unknown", { now: askedAt + 10_000, askedAt, windowClosedAt: null })).toEqual({ next: "wait" });
    expect(paypalLeaveStep("unknown", { now: askedAt + 10_000, askedAt, windowClosedAt: askedAt - 60_000 })).toEqual({ next: "wait" });
    // The window closed long ago (the background checks' own limit): no lock for good.
    expect(paypalLeaveStep("unknown", { now: askedAt + 2_500, askedAt, windowClosedAt: askedAt + 2_500 - PENDING_POLL_AFTER_CLOSE_MS })).toEqual({ next: "switch" });
  });

  it("a whole run: polls every ~2 s until paid, or switches / waits at the deadline", () => {
    const run = (states: ("paid" | "unpaid" | "inFlight")[], windowClosedAt: number | null) => {
      let now = askedAt;
      const seen: string[] = [];
      for (const state of states) {
        const step = paypalLeaveStep(state, { now, askedAt, windowClosedAt });
        seen.push(step.next);
        if (step.next !== "poll") return { seen, at: now - askedAt };
        now += step.inMs;
      }
      return { seen, at: now - askedAt };
    };
    // Paid shortly after the window closed: caught by the polling, never a switch to the card.
    expect(run(["unpaid", "unpaid", "unpaid", "paid"], askedAt)).toEqual({ seen: ["poll", "poll", "poll", "paid"], at: 6_000 });
    expect(run(Array(10).fill("unpaid"), askedAt)).toEqual({ seen: ["poll", "poll", "poll", "poll", "poll", "switch"], at: 10_000 });
    expect(run(Array(10).fill("inFlight"), null)).toEqual({ seen: ["poll", "poll", "poll", "poll", "poll", "wait"], at: 10_000 });
    // No longer in flight: still the 2.5 s minimum before the switch.
    expect(run(["inFlight", "unpaid", "unpaid"], null)).toEqual({ seen: ["poll", "poll", "switch"], at: 2_500 });
  });

  it("paypalRetryStep's rule with lastSubmitAt: a submit older than the in-flight window, its window closed ~10 s ago → in flight counts as unpaid", async () => {
    const { PAYPAL_SERVER_IN_FLIGHT_MS, PAYPAL_AFTER_WINDOW_MS } = await import("@/components/checkout/Payment");
    // A "Continue with PayPal" retry that ended in "wait" marked the session PAYING again: the status
    // route says in flight, but the last real submit is old and its window long closed.
    const lastSubmitAt = askedAt - PAYPAL_SERVER_IN_FLIGHT_MS;
    const windowClosedAt = askedAt - PAYPAL_AFTER_WINDOW_MS;
    expect(paypalLeaveStep("inFlight", { now: askedAt, askedAt, windowClosedAt, lastSubmitAt })).toEqual({ next: "poll", inMs: PAYPAL_CHECK_POLL_MS });
    expect(paypalLeaveStep("inFlight", { now: askedAt + 2_500, askedAt, windowClosedAt, lastSubmitAt })).toEqual({ next: "switch" });
    expect(paypalLeaveStep("unknown", { now: askedAt + 2_500, askedAt, windowClosedAt, lastSubmitAt })).toEqual({ next: "switch" });
    // Without lastSubmitAt (or a recent submit, or a window closed moments ago): the in-flight wait as before.
    expect(paypalLeaveStep("inFlight", { now: askedAt + 10_000, askedAt, windowClosedAt })).toEqual({ next: "wait" });
    expect(paypalLeaveStep("inFlight", { now: askedAt + 10_000, askedAt, windowClosedAt, lastSubmitAt: askedAt - 5_000 })).toEqual({ next: "wait" });
    expect(paypalLeaveStep("inFlight", { now: askedAt + 10_000, askedAt, windowClosedAt: null, lastSubmitAt })).toEqual({ next: "wait" });
    // The rule kicks in mid-run: in flight until the submit turns old, then the switch.
    const recent = askedAt - PAYPAL_SERVER_IN_FLIGHT_MS + 4_000;
    expect(paypalLeaveStep("inFlight", { now: askedAt + 3_000, askedAt, windowClosedAt, lastSubmitAt: recent })).toEqual({ next: "poll", inMs: PAYPAL_CHECK_POLL_MS });
    expect(paypalLeaveStep("inFlight", { now: askedAt + 4_000, askedAt, windowClosedAt, lastSubmitAt: recent })).toEqual({ next: "switch" });
    // Paid always wins.
    expect(paypalLeaveStep("paid", { now: askedAt, askedAt, windowClosedAt, lastSubmitAt })).toEqual({ next: "paid" });
  });
});

describe("PayPal timings shared by the checkout page and the status route", async () => {
  const timing = await import("@/lib/paypal-timing");
  const { PAYPAL_SERVER_IN_FLIGHT_MS, paypalRetryStep, PAYPAL_AFTER_WINDOW_MS } = await import("@/components/checkout/Payment");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  it("one in-flight window: the page's retry bound is the status route's own constant", () => {
    expect(PAYPAL_SERVER_IN_FLIGHT_MS).toBe(timing.PAYPAL_SERVER_IN_FLIGHT_MS);
    // The status route uses the one formula (inFlightMethod, bounded by that constant): no timing of its own.
    const route = readFileSync(join(process.cwd(), "src/app/api/public/sessions/[id]/status/route.ts"), "utf8");
    expect(route).toMatch(/inFlightMethod\([^)]*\) !== null/);
    expect(route).not.toMatch(/30_000|PAYPAL_SERVER_IN_FLIGHT_MS/);
    const checkout = readFileSync(join(process.cwd(), "src/lib/checkout.ts"), "utf8");
    expect(checkout).toMatch(/import \{ PAYPAL_SERVER_IN_FLIGHT_MS \} from "\.\/paypal-timing"/);
    // Loadable by the client bundle: no imports at all (no server-only module).
    expect(readFileSync(join(process.cwd(), "src/lib/paypal-timing.ts"), "utf8")).not.toMatch(/^\s*import\s/m);
    // The retry waits exactly that long after the last submit (its window long closed).
    const t = { lastSubmitAt: 0, windowClosedAt: -PAYPAL_AFTER_WINDOW_MS };
    expect(paypalRetryStep("inFlight", { ...t, now: timing.PAYPAL_SERVER_IN_FLIGHT_MS - 1 })).toBe("wait");
    expect(paypalRetryStep("inFlight", { ...t, now: timing.PAYPAL_SERVER_IN_FLIGHT_MS })).toBe("submit");
  });
});

describe("paypalChoiceReset (the checkout page ending the PayPal choice)", async () => {
  const { paypalChoiceReset } = await import("@/components/checkout/CheckoutView");

  it("PayPal withdrawn and dropped resets like \"Pay another way\" (prepare signature included), its message kept", () => {
    const stop = paypalChoiceReset({ keepError: false });
    const drop = paypalChoiceReset({ keepError: true });
    expect(stop).toEqual({ mode: false, prepared: null, doneSig: null, autoSubmit: false, notice: null, error: null });
    expect(drop).toEqual({ mode: false, prepared: null, doneSig: null, autoSubmit: false, notice: null });
    expect(drop).not.toHaveProperty("error");
  });
});

describe("createCheckoutConfiguration: a refused method list isn't asked again", () => {
  beforeEach(() => {
    sdk.create.mockReset();
    store.settings.clear();
  });

  it("after Whop refused the optional methods (422), the next checkout asks the working list first (one Whop call)", async () => {
    const memoOpts = { ...opts, storeId: "memo_store" };
    sdk.create.mockRejectedValueOnce(Object.assign(new Error("klarna not available"), { statusCode: 422 })).mockResolvedValueOnce(config(["card", "paypal"], "ch_memo_1"));
    await createCheckoutConfiguration(whopStore, memoOpts);
    expect(sdk.create).toHaveBeenCalledTimes(2);
    sdk.create.mockReset().mockResolvedValueOnce(config(["card", "paypal"], "ch_memo_2"));
    const res = await createCheckoutConfiguration(whopStore, { ...memoOpts, sessionId: "memo_2" });
    expect(res.id).toBe("ch_memo_2");
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(sdk.create.mock.calls[0][0].payment_method_configuration.enabled).not.toContain("klarna");
  });

  it("a timeout or a 5xx is never remembered: the next checkout asks the full list again", async () => {
    const memoOpts = { ...opts, storeId: "memo_store_5xx" };
    sdk.create.mockRejectedValueOnce(Object.assign(new Error("upstream"), { statusCode: 503 })).mockResolvedValueOnce(config(["card", "paypal"]));
    await createCheckoutConfiguration(whopStore, memoOpts);
    sdk.create.mockReset().mockResolvedValueOnce(config(["card", "paypal", "klarna"]));
    await createCheckoutConfiguration(whopStore, { ...memoOpts, sessionId: "memo_3" });
    expect(sdk.create.mock.calls[0][0].payment_method_configuration.enabled).toContain("klarna");
  });
});
