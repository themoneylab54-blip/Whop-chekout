// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, type ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/*
 * The payment panel taking over Whop's form started by the server HTML (see inlineEarlyWhop), through
 * the real path: the page server-rendered, the early start run on its HTML (Whop's plain script
 * mocked: a frame in its element, its controls spied), then the page hydrated and its first checkout
 * given. When the frame is the panel's very form (same checkout and options, Whop's script running),
 * no second frame opens: the same frame stays through hydration (StrictMode too), one spinner and one
 * clip at a time (the early ones until the frame is taken over, the panel's after), Whop's events
 * (those sent before too) are handled as the React embed's, with the panel's latest handlers, and
 * paying goes through Whop's script by the frame's element. An early clip given up stays given up.
 * Otherwise — another checkout, other options, Whop's script not running, no frame, a failed prepare —
 * the slot goes with its frame (the early start dropped) and the React embed opens; a frame taken over
 * goes for good with a new checkout or PayPal. Without an early start, the panel as before.
 */

type EmbedProps = { sessionId: string };
const whop = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("@whop/checkout/react", async () => {
  const React = await import("react");
  function WhopCheckoutEmbed(props: EmbedProps & { ref?: React.Ref<unknown> }) {
    React.useImperativeHandle(props.ref, () => ({ submit: async () => undefined, setEmail: async () => undefined, setAddress: async () => undefined }));
    React.useEffect(() => void whop.opened.push(props.sessionId), [props.sessionId]);
    return React.createElement("iframe", { "data-testid": "embed", "data-config": props.sessionId, title: "Whop Embedded Checkout" });
  }
  return { WhopCheckoutEmbed, WhopExpressCheckoutButton: () => null, useCheckoutEmbedControls: () => React.useRef(null) };
});

const { PaymentPanel } = await import("@/components/checkout/Payment");
const { LABELS } = await import("@/components/checkout/i18n");
const { EARLY_EMBED_ID, EARLY_FLAG, EARLY_SLOT_ID, inlineEarlyWhopScript } = await import("@/components/checkout/inlineEarlyWhop");
const { thankYouPath } = await import("@/components/checkout/thankYouPath");
const { WHOP_SDK_PATH, whopEmbedFixedAttributes } = await import("@/components/checkout/whopEmbed");
const { whopFooterFitRuns } = await import("@/components/checkout/whopFooterFit");
const { PANEL_SPINNER_CLASS, WHOP_READY_GRACE_MS } = await import("@/components/checkout/whopFrame");

type Win = Window & Record<string, unknown>;
const win = () => window as unknown as Win;
/** Microtasks only (the prepare's answer, MutationObserver's deliveries): safe under fake timers. */
const microtasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const SESSION = "cmsess1";
const theme = { language: "fr", accentColor: "#000", radius: 8, requireTerms: false } as unknown as ComponentProps<typeof PaymentPanel>["theme"];
const buyer = { email: "a@b.co", address: { name: "A B", line1: "1 rue", city: "Paris", state: "", postalCode: "75001", country: "FR" } };
const callbacks = ["__wcEarlyState", "__wcEarlyComplete", "__wcEarlyPaymentError", "__wcEarlyAddressError"];

const onPaid = vi.fn();
const onReady = vi.fn();
type PanelInput = {
  prepared?: { configId: string; environment: "sandbox" | "production" } | null;
  preparing?: boolean;
  prepareError?: string | null;
  saveCard?: boolean;
  paypalActive?: boolean;
  earlyWhop?: boolean;
  labels?: (typeof LABELS)["fr"];
};
function panel(o: PanelInput = {}) {
  return h(PaymentPanel, {
    prepared: o.prepared === undefined ? { configId: "cfg_card", environment: "sandbox" } : o.prepared,
    preparing: o.preparing ?? false,
    prepareError: o.prepareError ?? null,
    theme,
    labels: o.labels ?? LABELS.fr,
    payLabel: "Payer",
    returnUrl: `${location.origin}${thankYouPath(SESSION, "fr", false)}`,
    testMode: false,
    confirm: async () => ({ ok: true as const, buyer }),
    onPaid,
    saveCard: o.saveCard ?? false,
    whopFooterLang: "fr",
    onReady,
    earlyWhop: o.earlyWhop ?? true,
    paypal: {
      active: o.paypalActive ?? false,
      prepared: { configId: "cfg_paypal", environment: "sandbox" },
      preparing: false,
      error: null,
      autoSubmit: false,
      onAutoSubmitted: () => undefined,
      onCancel: () => undefined,
      formKey: "k1",
    },
  });
}

/** Whop's plain script's controls (window.wco), spied. */
const wco = {
  submit: vi.fn(async () => undefined),
  setEmail: vi.fn(async () => undefined),
  setAddress: vi.fn(async () => undefined),
  getEmail: vi.fn(),
  getAddress: vi.fn(),
  setDisplayCurrency: vi.fn(),
  getAvailableCurrencies: vi.fn(() => null),
};

/** The ResizeObservers made (the early clip's watches the slot, WhopFooterClip's its own box). */
let observers: { cb: ResizeObserverCallback; target: Element | null; disconnected: boolean }[];
/**
 * The server HTML of the panel (no checkout yet), the early start run on it with the inline prepare's
 * answer (Whop's checkout `configId`), then Whop's plain script (mocked): a frame in its element, its
 * controls; `listening` false: its file never ran. The early clip's first observation then (the slot
 * at 340 px).
 */
async function serverPage(o: { configId?: string; frame?: boolean; listening?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  container.innerHTML = renderToString(panel({ prepared: null }));
  win().__wcPrepare = {
    id: SESSION,
    body: "{}",
    at: Date.now(),
    p: Promise.resolve({ status: 200, text: JSON.stringify({ provider: "whop", checkoutConfigurationId: o.configId ?? "cfg_card", environment: "sandbox" }), ref: null }),
  };
  const attributes = whopEmbedFixedAttributes({ locale: "fr", accentColor: "#000", borderRadius: 8, submitButton: false, addressForm: false, hideTerms: false, saveCard: false });
  new Function(inlineEarlyWhopScript({ sessionId: SESSION, attributes, returnPath: thankYouPath(SESSION, "fr", false), fit: whopFooterFitRuns("fr"), sdk: WHOP_SDK_PATH }))();
  await microtasks();
  const el = document.getElementById(EARLY_EMBED_ID);
  if (!el) throw new Error("the early start opened nothing");
  const frame = document.createElement("iframe");
  frame.title = "Whop Embedded Checkout";
  if (o.frame !== false) el.append(frame);
  Object.assign(win().wco as object, wco, { listening: o.listening ?? true });
  await microtasks();
  for (const ro of observers.filter((r) => r.target?.id === EARLY_SLOT_ID)) ro.cb([{ contentRect: { width: 340 } } as ResizeObserverEntry], {} as ResizeObserver);
  return { container, frame };
}
const slot = () => document.getElementById(EARLY_SLOT_ID);
/** The early start's clipping box (around its frame's element). */
const earlyClip = () => document.getElementById(EARLY_EMBED_ID)?.parentElement?.parentElement ?? null;
/** The panel's own clipping box (WhopFooterClip's). */
const panelClip = () => screen.queryByTestId("wc-whop-clip");
/** The spinners over Whop's form (the panel's box, or the early start's same box in the slot; not the pay button's). */
const spinners = () => [...document.querySelectorAll(`.${PANEL_SPINNER_CLASS.split(" ").join(".")}`)].map((s) => (slot()?.contains(s) ? "early" : "panel"));
const embeds = () => screen.queryAllByTestId("embed").map((e) => e.getAttribute("data-config"));
const payButton = () => document.getElementById("wc-pay-button") as HTMLButtonElement;
let errors: string[];

beforeEach(() => {
  whop.opened = [];
  errors = [];
  observers = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      entry: (typeof observers)[number];
      constructor(cb: ResizeObserverCallback) {
        this.entry = { cb, target: null, disconnected: false };
        observers.push(this.entry);
      }
      observe(el: Element) {
        this.entry.target = el;
      }
      disconnect() {
        this.entry.disconnected = true;
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => 340);
});
afterEach(() => {
  // Never a hydration mismatch nor any other error React reports.
  expect(errors).toEqual([]);
  vi.useRealTimers();
  cleanup();
  document.body.innerHTML = "";
  for (const k of ["__wcPrepare", EARLY_FLAG, "wco", "whop", ...callbacks]) delete win()[k];
  for (const s of document.head.querySelectorAll("script")) s.remove();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PaymentPanel: Whop's form started before the page ran", () => {
  it("its very form: taken over, the same frame through hydration, no second frame; one clip and one spinner at a time", async () => {
    const { container, frame } = await serverPage();
    expect(earlyClip()!.getAttribute("data-clip")).toBe("86");
    expect(spinners()).toEqual(["early"]);
    const page = render(panel({ prepared: null }), { container, hydrate: true });
    // The page runs, its checkout on its way: the early clip and spinner stay, the panel's are off.
    page.rerender(panel({ prepared: null, preparing: true }));
    expect(spinners()).toEqual(["early"]);
    expect(earlyClip()!.getAttribute("data-clip")).toBe("86");
    expect(panelClip()!.hasAttribute("data-clip")).toBe(false);
    // Its checkout: the frame taken over, the panel's clip and spinner instead.
    page.rerender(panel());
    expect(embeds()).toEqual([]);
    expect(whop.opened).toEqual([]);
    expect(slot()!.querySelector("iframe")).toBe(frame);
    expect(panelClip()!.getAttribute("data-clip")).toBe("86");
    expect(earlyClip()!.className).toBe("");
    expect(earlyClip()!.hasAttribute("data-clip")).toBe(false);
    expect(spinners()).toEqual(["panel"]);
    act(() => (win().__wcEarlyState as (s: string) => void)("ready"));
    expect(spinners()).toEqual([]);
  });

  it("the same in StrictMode (effects run twice): taken over once, events not doubled, paying through Whop's script", async () => {
    const { container, frame } = await serverPage();
    (win().__wcEarlyState as (s: string) => void)("ready");
    const page = render(panel({ prepared: null }), { container, hydrate: true, reactStrictMode: true });
    page.rerender(panel());
    expect(embeds()).toEqual([]);
    expect(slot()!.querySelector("iframe")).toBe(frame);
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(spinners()).toEqual([]);
    act(() => (win().__wcEarlyComplete as (...a: unknown[]) => void)("plan_1", "rcpt_1", { receipt_id: "rcpt_1" }));
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it("its events handled as the React embed's: a 'ready' said before the page ran, a refused card, the payment complete", async () => {
    const { container } = await serverPage();
    (win().__wcEarlyState as (s: string) => void)("loading");
    (win().__wcEarlyState as (s: string) => void)("ready");
    // Ready before the page ran: no spinner left at all.
    expect(spinners()).toEqual([]);
    const page = render(panel({ prepared: null }), { container, hydrate: true });
    page.rerender(panel({ prepared: null, preparing: true }));
    expect(spinners()).toEqual([]);
    page.rerender(panel());
    expect(spinners()).toEqual([]);
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(payButton().getAttribute("aria-busy")).not.toBe("true");
    act(() => (win().__wcEarlyPaymentError as (e: unknown) => void)({ message: "Carte refusée", code: "card_declined" }));
    expect(screen.getByRole("alert").textContent).toContain("Carte refusée");
    act(() => (win().__wcEarlyComplete as (...a: unknown[]) => void)("plan_1", "rcpt_1", { receipt_id: "rcpt_1" }));
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it("its events go to the panel's latest handlers (its props of the last render)", async () => {
    const { container } = await serverPage();
    const page = render(panel({ prepared: null }), { container, hydrate: true });
    page.rerender(panel());
    page.rerender(panel({ labels: LABELS.en }));
    expect(LABELS.en.paymentFailed).not.toBe(LABELS.fr.paymentFailed);
    act(() => (win().__wcEarlyPaymentError as (e: unknown) => void)({}));
    expect(screen.getByRole("alert").textContent).toContain(LABELS.en.paymentFailed);
  });

  it("paying goes through Whop's plain script, by the frame's element", async () => {
    const { container } = await serverPage();
    (win().__wcEarlyState as (s: string) => void)("ready");
    const page = render(panel({ prepared: null }), { container, hydrate: true });
    page.rerender(panel());
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    fireEvent.click(payButton());
    await waitFor(() => expect(wco.submit).toHaveBeenCalledTimes(1));
    expect(wco.setEmail).toHaveBeenCalledWith(EARLY_EMBED_ID, "a@b.co", undefined);
    expect(wco.setAddress).toHaveBeenCalledWith(EARLY_EMBED_ID, buyer.address, undefined);
    expect(wco.submit).toHaveBeenCalledWith(EARLY_EMBED_ID, undefined);
  });

  it("Whop asking for the billing address (an address error): its error said, the form shown whole (no clip), in the same frame", async () => {
    const { container, frame } = await serverPage();
    const page = render(panel({ prepared: null }), { container, hydrate: true });
    page.rerender(panel());
    expect(panelClip()!.getAttribute("data-clip")).toBe("86");
    act(() => (win().__wcEarlyAddressError as (e: unknown) => void)({ error_message: "Adresse de facturation à vérifier", error_code: "x" }));
    expect(screen.getByRole("alert").textContent).toContain("Adresse de facturation à vérifier");
    expect(panelClip()!.hasAttribute("data-clip")).toBe(false);
    // Whop shows its address form in that frame (as the React embed's, never reloaded).
    expect(slot()!.querySelector("iframe")).toBe(frame);
    expect(embeds()).toEqual([]);
  });

  it("the panel gone with its frame not taken over (another provider's panel instead, the page left): the early start dropped all the same", async () => {
    const { container } = await serverPage();
    const page = render(panel({ prepared: null }), { container, hydrate: true });
    page.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(win()[EARLY_FLAG]).toBeNull();
    for (const k of callbacks) expect(win()[k]).toBeUndefined();
  });

  it("an early clip given up (no 'ready' within its grace) stays given up: the panel doesn't clip that frame", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { container } = await serverPage();
    vi.advanceTimersByTime(WHOP_READY_GRACE_MS);
    vi.useRealTimers();
    expect(earlyClip()!.hasAttribute("data-clip")).toBe(false);
    const page = render(panel({ prepared: null }), { container, hydrate: true });
    page.rerender(panel());
    expect(embeds()).toEqual([]);
    expect(panelClip()!.hasAttribute("data-clip")).toBe(false);
  });

  type Given = PanelInput;
  it.each<[string, Parameters<typeof serverPage>[0], Given]>([
    ["another checkout (the page's first prepare asked again)", {}, { prepared: { configId: "cfg_other", environment: "sandbox" } }],
    ["other options (the card saved for an offer)", {}, { saveCard: true }],
    ["Whop's script not running (its file never ran)", { listening: false }, {}],
    ["no frame in its element", { frame: false }, {}],
  ])("not its very form — %s: the slot goes with its frame (the early start dropped), the React embed opens", async (_case, early, given) => {
    const { container } = await serverPage(early);
    const page = render(panel({ ...given, prepared: null }), { container, hydrate: true });
    page.rerender(panel(given));
    expect(slot()).toBeNull();
    expect(document.getElementById(EARLY_EMBED_ID)).toBeNull();
    expect(embeds()).toEqual([given.prepared?.configId ?? "cfg_card"]);
    expect(win()[EARLY_FLAG]).toBeNull();
    for (const k of callbacks) expect(win()[k]).toBeUndefined();
    expect(observers.filter((r) => r.target?.id === EARLY_SLOT_ID).every((r) => r.disconnected)).toBe(true);
    expect(spinners()).toEqual(["panel"]);
  });

  it("the page's prepare failing while the frame may be taken: the slot goes (the early start dropped), the panel's error instead", async () => {
    const { container } = await serverPage();
    const page = render(panel({ prepared: null }), { container, hydrate: true });
    page.rerender(panel({ prepared: null, prepareError: LABELS.fr.error }));
    expect(slot()).toBeNull();
    expect(win()[EARLY_FLAG]).toBeNull();
    expect(screen.getByText(LABELS.fr.paymentUnavailable)).toBeTruthy();
    expect(spinners()).toEqual([]);
    // A retry that works: the React embed's own frame.
    page.rerender(panel());
    expect(embeds()).toEqual(["cfg_card"]);
  });

  it("taken over, then a new checkout (another total): the early frame goes for good, the React embed opens", async () => {
    const { container } = await serverPage();
    const page = render(panel({ prepared: null }), { container, hydrate: true });
    page.rerender(panel());
    expect(embeds()).toEqual([]);
    page.rerender(panel({ prepared: { configId: "cfg_new", environment: "sandbox" } }));
    expect(slot()).toBeNull();
    expect(win()[EARLY_FLAG]).toBeNull();
    expect(embeds()).toEqual(["cfg_new"]);
    page.rerender(panel({ prepared: { configId: "cfg_card", environment: "sandbox" } }));
    expect(slot()).toBeNull();
    expect(embeds()).toEqual(["cfg_card"]);
  });

  it("taken over, then PayPal chosen: the PayPal checkout opens; back to the card, the React embed's own frame", async () => {
    const { container } = await serverPage();
    const page = render(panel({ prepared: null }), { container, hydrate: true });
    page.rerender(panel());
    page.rerender(panel({ paypalActive: true }));
    expect(slot()).toBeNull();
    expect(embeds()).toEqual(["cfg_paypal"]);
    page.rerender(panel({ paypalActive: false }));
    expect(slot()).toBeNull();
    expect(embeds()).toEqual(["cfg_card"]);
  });

  it("no early start (the page ran first): the panel as before (its own spinner), and none begins afterwards", async () => {
    const page = render(panel({ prepared: null }));
    expect(win()[EARLY_FLAG]).toBeNull();
    expect(slot()).not.toBeNull();
    page.rerender(panel({ prepared: null, preparing: true }));
    expect(spinners()).toEqual(["panel"]);
    page.rerender(panel());
    expect(slot()).toBeNull();
    expect(embeds()).toEqual(["cfg_card"]);
  });

  it("not started by the server (a Stripe checkout expected, say): no slot at all", () => {
    render(panel({ prepared: null, earlyWhop: false }));
    expect(slot()).toBeNull();
    expect(win()[EARLY_FLAG]).toBeUndefined();
  });
});
