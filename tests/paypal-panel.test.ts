// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, useEffect, useRef, useState, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/*
 * The payment panel's PayPal state machine, rendered (jsdom, fake timers) with Whop's embed mocked:
 * background status checks, the pending state and its lock, Whop's own PayPal button after a
 * blocked window, "Pay another way" (confirm → wait or switch), "Continue with PayPal" while a
 * payment may be pending, and the express grid's lock line.
 */

type EmbedProps = {
  sessionId: string;
  hideSubmitButton?: boolean;
  onStateChange?: (s: string) => void;
  onComplete?: () => void;
  onPaymentError?: (e: { message: string }) => void;
};

const whop = vi.hoisted(() => ({
  submit: vi.fn<() => Promise<void>>(),
  last: null as EmbedProps | null,
}));

vi.mock("@whop/checkout/react", async () => {
  const React = await import("react");
  function WhopCheckoutEmbed(props: EmbedProps & { ref?: React.Ref<unknown> }) {
    React.useImperativeHandle(props.ref, () => ({ submit: whop.submit, setEmail: async () => undefined, setAddress: async () => undefined }));
    const { onStateChange } = props;
    React.useEffect(() => {
      onStateChange?.("ready");
      // Once per mount, like Whop's "ready".
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    whop.last = props;
    // Whop's own submit button (its PayPal button in a PayPal-only checkout) lives in an iframe.
    return React.createElement(
      "div",
      { "data-testid": "embed", "data-config": props.sessionId },
      props.hideSubmitButton ? null : React.createElement("iframe", { "data-testid": "whop-paypal-button", title: "PayPal" }),
    );
  }
  return {
    WhopCheckoutEmbed,
    WhopExpressCheckoutButton: () => null,
    useCheckoutEmbedControls: () => React.useRef(null),
  };
});

const {
  PaymentPanel,
  ExpressCheckout,
  paypalStaysChosen,
  PENDING_POLL_MS,
  PENDING_POLL_AFTER_CLOSE_MS,
  SERVER_WAIT_POLL_MS,
  serverWaitNext,
  PAYPAL_SERVER_IN_FLIGHT_MS,
  PAYPAL_HEARTBEAT_MS,
  PAYPAL_WINDOW_MAX_MS,
  CARD_DECLINED_RECENT_MS,
} = await import("@/components/checkout/Payment");
type PanelLock = import("@/components/checkout/Payment").PanelLock;
type PaidCheck = import("@/components/checkout/Payment").PaidCheck;
const { LABELS } = await import("@/components/checkout/i18n");
const L = LABELS.fr;
const theme = { language: "fr", accentColor: "#000", radius: 8, requireTerms: false } as unknown as ComponentProps<typeof PaymentPanel>["theme"];
const buyer = { email: "a@b.co", address: { name: "A B", line1: "1 rue", city: "Paris", state: "", postalCode: "75001", country: "FR" } };

// The page's focus as the PayPal window takes and gives it back.
let focused = true;
function paypalWindow(open: boolean) {
  focused = !open;
}
// A tab switch (or the browser minimized): the page hidden, not just blurred.
let visible = true;
function tabSwitch(away: boolean) {
  visible = !away;
  focused = !away;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

type Opts = {
  checkPaid?: () => Promise<PaidCheck>;
  formKey?: string;
  onCancel?: () => void;
  onPaid?: () => void;
  onLockChange?: (l: PanelLock) => void;
  active?: boolean;
  confirm?: ComponentProps<typeof PaymentPanel>["confirm"];
  onWhopWindow?: () => void;
  onWindowBlocked?: () => void;
  onWindowBeat?: () => void;
  onWindowClosed?: () => void;
};
function panel(o: Opts = {}) {
  return h(PaymentPanel, {
    prepared: { configId: "cfg_card", environment: "sandbox" },
    preparing: false,
    prepareError: null,
    theme,
    labels: L,
    payLabel: "Payer",
    returnUrl: "https://x.test/merci",
    testMode: false,
    confirm: o.confirm ?? (async () => ({ ok: true as const, buyer })),
    onPaid: o.onPaid ?? (() => undefined),
    onLockChange: o.onLockChange,
    paypal: {
      active: o.active ?? true,
      prepared: { configId: "cfg_paypal", environment: "sandbox" },
      preparing: false,
      error: null,
      autoSubmit: false,
      onAutoSubmitted: () => undefined,
      onCancel: o.onCancel ?? (() => undefined),
      checkPaid: o.checkPaid,
      formKey: o.formKey ?? "k1",
      onWhopWindow: o.onWhopWindow,
      onWindowBlocked: o.onWindowBlocked,
      onWindowBeat: o.onWindowBeat,
      onWindowClosed: o.onWindowClosed,
    },
  });
}

const payButton = () => document.getElementById("wc-pay-button") as HTMLButtonElement;

/** "Continue with PayPal" with a window that really opens, then closes after `openMs`. */
async function payWithOpenWindow(openMs = 5_000) {
  whop.submit.mockImplementationOnce(async () => {
    paypalWindow(true);
  });
  fireEvent.click(payButton());
  await advance(400);
  await advance(openMs);
  paypalWindow(false);
  await advance(400);
}

beforeEach(() => {
  vi.useFakeTimers();
  focused = true;
  visible = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (visible ? "visible" : "hidden") });
  whop.submit.mockReset().mockResolvedValue(undefined);
  whop.last = null;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PaymentPanel: PayPal pending state", () => {
  it("a PayPal payment completed in its window reaches the thank-you page from the background checks, once", async () => {
    const onPaid = vi.fn();
    const answers: PaidCheck[] = ["unpaid", "inFlight", "paid"];
    const checkPaid = vi.fn(async () => answers.shift() ?? "paid");
    const locks: PanelLock[] = [];
    render(panel({ checkPaid, onPaid, onLockChange: (l) => locks.push(l) }));
    await advance(0);
    await payWithOpenWindow();
    expect(locks.at(-1)).toBe("pending");
    await advance(PENDING_POLL_MS * 3);
    expect(onPaid).toHaveBeenCalledTimes(1);
    // Whop's own completion arriving too: still one thank-you navigation.
    act(() => whop.last?.onComplete?.());
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it("the background checks stop ~2 min after the window closed with the session unpaid", async () => {
    const checkPaid = vi.fn(async (): Promise<PaidCheck> => "unpaid");
    render(panel({ checkPaid }));
    await advance(0);
    await payWithOpenWindow();
    await advance(PENDING_POLL_AFTER_CLOSE_MS + PENDING_POLL_MS * 2);
    const calls = checkPaid.mock.calls.length;
    expect(calls).toBeGreaterThan(20);
    await advance(10 * 60_000);
    expect(checkPaid.mock.calls.length).toBe(calls);
  });

  it("PayPal dropped by the parent: nothing of it stays pending (lock released)", async () => {
    const locks: PanelLock[] = [];
    const onLockChange = (l: PanelLock) => locks.push(l);
    const checkPaid = vi.fn(async (): Promise<PaidCheck> => "unpaid");
    const { rerender } = render(panel({ checkPaid, onLockChange }));
    await advance(0);
    await payWithOpenWindow();
    expect(locks.at(-1)).toBe("pending");
    rerender(panel({ checkPaid, onLockChange, active: false }));
    await advance(0);
    expect(locks.at(-1)).toBeNull();
    expect(screen.queryByTestId("wc-paypal-selected")).toBeNull();
  });

  it("PayPal dropped then chosen again: no stale \"window blocked\" hint, no wait left from the dropped payment", async () => {
    const checkPaid = vi.fn(async (): Promise<PaidCheck> => "inFlight");
    const { rerender } = render(panel({ checkPaid }));
    await advance(0);
    // A blocked window: the hint shows.
    fireEvent.click(payButton());
    await advance(3_500);
    expect(screen.getByTestId("wc-paypal-popup-hint")).toBeTruthy();
    rerender(panel({ checkPaid, active: false }));
    await advance(0);
    rerender(panel({ checkPaid, active: true }));
    await advance(0);
    expect(screen.queryByTestId("wc-paypal-popup-hint")).toBeNull();
    // A new PayPal payment then "Continue with PayPal" long after: its own timings only.
    await payWithOpenWindow();
    await advance(31_000);
    whop.submit.mockImplementationOnce(async () => paypalWindow(true));
    fireEvent.click(payButton());
    await advance(400);
    expect(whop.submit).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("wc-paypal-wait")).toBeNull();
  });

  it("PayPal withdrawn while its payment is pending stays chosen until the panel unlocks (the parent's deferral)", async () => {
    const onCancel = vi.fn();
    let withdraw: () => void = () => undefined;
    const checkPaid = vi.fn(async (): Promise<PaidCheck> => "unpaid");
    // The checkout page's rule (CheckoutView): PayPal active = paypalStaysChosen(mode, offered, lock).
    function Harness() {
      const [mode, setMode] = useState(true);
      const [offered, setOffered] = useState(true);
      const [lock, setLock] = useState<PanelLock>(null);
      withdraw = () => setOffered(false);
      if (mode && !offered && lock === null) setMode(false);
      return h("div", null, [
        h(ExpressCheckout, {
          key: "x",
          prepared: { configId: "cfg_card", environment: "sandbox" },
          theme,
          labels: L,
          returnUrl: "https://x.test/merci",
          email: "",
          onPaid: () => undefined,
          paypal: offered ? { onClick: () => undefined, busy: false } : null,
          lock,
        }),
        h("div", { key: "p" }, panel({ checkPaid, onLockChange: setLock, active: paypalStaysChosen({ mode, offered, lock }), onCancel: () => (onCancel(), setMode(false)) })),
      ]);
    }
    render(h(Harness));
    await advance(0);
    await payWithOpenWindow();
    expect(screen.getByTestId("wc-express-locked").textContent).toBe(L.paypalExpressLocked);
    act(() => withdraw());
    await advance(0);
    // Still on PayPal with its pending payment; only the PayPal express button went, the grid stays locked.
    expect(screen.getByTestId("wc-paypal-selected")).toBeTruthy();
    expect(screen.queryByTestId("wc-paypal-express")).toBeNull();
    expect(screen.getByTestId("wc-express-locked").textContent).toBe(L.paypalExpressLocked);
    // "Pay another way" → closed → unpaid after the checks: switch, and the lock is gone.
    fireEvent.click(screen.getByText(L.paypalPayOther));
    fireEvent.click(screen.getByText(L.paypalConfirmYes));
    await advance(12_000);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("wc-paypal-selected")).toBeNull();
    expect(screen.getByTestId("wc-express-locked").textContent).toBe("");
  });
});

describe("PaymentPanel: Whop's own PayPal button after a blocked window", () => {
  it("shows for the confirmed details only, hides after an edit; a blocked window leaves no lock", async () => {
    const locks: PanelLock[] = [];
    const onCancel = vi.fn();
    const { rerender } = render(panel({ formKey: "k1", onLockChange: (l) => locks.push(l), onCancel }));
    await advance(0);
    expect(screen.queryByTestId("whop-paypal-button")).toBeNull();
    // The window never takes the focus (blocked popup).
    fireEvent.click(payButton());
    await advance(3_500);
    expect(whop.submit).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("whop-paypal-button")).toBeTruthy();
    expect(screen.getByTestId("wc-paypal-popup-hint").textContent).toBe(L.paypalUseWhopButton);
    expect(locks.at(-1)).toBeNull();
    // Nothing pending: "Pay another way" switches at once, no question.
    rerender(panel({ formKey: "k2", onLockChange: (l) => locks.push(l), onCancel }));
    await advance(0);
    expect(screen.queryByTestId("whop-paypal-button")).toBeNull();
    fireEvent.click(screen.getByText(L.paypalPayOther));
    await advance(0);
    expect(screen.queryByTestId("wc-paypal-confirm")).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("a blocked window tells the server (onWindowBlocked) once; a window that opens never does", async () => {
    const onWindowBlocked = vi.fn();
    render(panel({ onWindowBlocked, checkPaid: async () => "unpaid" }));
    await advance(0);
    fireEvent.click(payButton());
    await advance(3_500);
    expect(screen.getByTestId("whop-paypal-button")).toBeTruthy();
    expect(onWindowBlocked).toHaveBeenCalledTimes(1);
    cleanup();
    whop.submit.mockReset().mockResolvedValue(undefined);
    const opened = vi.fn();
    render(panel({ onWindowBlocked: opened, checkPaid: async () => "unpaid" }));
    await advance(0);
    await payWithOpenWindow();
    expect(opened).not.toHaveBeenCalled();
  });

  it("a tab switch arms nothing; a click inside the embed then its PayPal window makes the payment pending", async () => {
    const locks: PanelLock[] = [];
    render(panel({ onLockChange: (l) => locks.push(l), checkPaid: async () => "unpaid" }));
    await advance(0);
    fireEvent.click(payButton());
    await advance(3_500);
    const iframe = screen.getByTestId("whop-paypal-button");
    // Tab switch without touching the embed, right after the "blocked" verdict (the late-popup
    // watch still running): the page hidden is no popup, nothing is pending.
    tabSwitch(true);
    act(() => {
      window.dispatchEvent(new Event("blur"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(1_000);
    expect(locks.at(-1)).toBeNull();
    expect(screen.getByTestId("whop-paypal-button")).toBe(iframe);
    tabSwitch(false);
    await advance(400);
    expect(locks.at(-1)).toBeNull();
    // Click inside the embed (the focus moves into its iframe), then PayPal's window opens.
    act(() => {
      iframe.focus();
      window.dispatchEvent(new Event("blur"));
    });
    await advance(0);
    paypalWindow(true);
    await advance(400);
    expect(locks.at(-1)).toBe("pending");
  });
});

describe("PaymentPanel: \"Pay another way\" while a payment is pending", () => {
  it("asks first (focus on \"Yes, it's closed\", a labelled group, one polite announcement), then waits while in flight", async () => {
    const onCancel = vi.fn();
    render(panel({ checkPaid: async () => "inFlight", onCancel }));
    await advance(0);
    await payWithOpenWindow();
    fireEvent.click(screen.getByText(L.paypalPayOther));
    await advance(0);
    const group = screen.getByTestId("wc-paypal-confirm");
    expect(group.getAttribute("role")).toBe("group");
    expect(document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(L.paypalConfirmClosed);
    expect(document.activeElement?.textContent).toBe(L.paypalConfirmYes);
    // The focus into the labelled group announces the question: not repeated by the live region.
    expect(screen.getByTestId("wc-paypal-live").textContent).toBe("");
    expect(screen.getByTestId("wc-paypal-live").getAttribute("aria-live")).toBe("polite");
    fireEvent.click(screen.getByText(L.paypalConfirmYes));
    await advance(12_000);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByTestId("wc-paypal-wait").textContent).toBe(L.paypalPaymentInFlight);
    expect(screen.getByTestId("wc-paypal-live").textContent).toBe(L.paypalPaymentInFlight);
    // The answer given, the focus is back on "Pay another way" (once usable again, after the checks).
    expect(document.activeElement?.textContent).toBe(L.paypalPayOther);
  });

  it("\"Not yet\": the question closes and the focus goes back to \"Pay another way\"", async () => {
    render(panel({ checkPaid: async () => "inFlight" }));
    await advance(0);
    await payWithOpenWindow();
    fireEvent.click(screen.getByText(L.paypalPayOther));
    await advance(0);
    expect(document.activeElement?.textContent).toBe(L.paypalConfirmYes);
    fireEvent.click(screen.getByText(L.paypalConfirmWait));
    await advance(0);
    expect(screen.queryByTestId("wc-paypal-confirm")).toBeNull();
    expect(document.activeElement?.textContent).toBe(L.paypalPayOther);
  });

  it("switches once the checks say unpaid (after the ~10 s following the window)", async () => {
    const onCancel = vi.fn();
    render(panel({ checkPaid: async () => "unpaid", onCancel }));
    await advance(0);
    await payWithOpenWindow();
    fireEvent.click(screen.getByText(L.paypalPayOther));
    fireEvent.click(screen.getByText(L.paypalConfirmYes));
    await advance(5_000);
    expect(onCancel).not.toHaveBeenCalled();
    await advance(8_000);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("failing checks fail closed: a wait that says the check failed, and the buyer can ask again", async () => {
    const onCancel = vi.fn();
    const checkPaid = vi.fn(async (): Promise<PaidCheck> => {
      throw new Error("offline");
    });
    render(panel({ checkPaid, onCancel }));
    await advance(0);
    await payWithOpenWindow();
    fireEvent.click(screen.getByText(L.paypalPayOther));
    fireEvent.click(screen.getByText(L.paypalConfirmYes));
    await advance(15_000);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByTestId("wc-paypal-wait").textContent).toBe(L.paypalCheckFailed);
    const again = screen.getByText(L.paypalPayOther) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    // Back online: the next try switches.
    checkPaid.mockImplementation(async () => "unpaid");
    fireEvent.click(again);
    fireEvent.click(screen.getByText(L.paypalConfirmYes));
    await advance(12_000);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("PaymentPanel: \"Continue with PayPal\" while a payment is pending", () => {
  it("in flight: no second submit, the wait message instead", async () => {
    render(panel({ checkPaid: async () => "inFlight" }));
    await advance(0);
    await payWithOpenWindow();
    expect(whop.submit).toHaveBeenCalledTimes(1);
    fireEvent.click(payButton());
    await advance(0);
    expect(whop.submit).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("wc-paypal-wait").textContent).toBe(L.paypalPaymentInFlight);
  });

  it("paid meanwhile: the thank-you page, no submit", async () => {
    const onPaid = vi.fn();
    const answers: PaidCheck[] = ["unpaid", "paid"];
    // Background checks see unpaid; the click's check sees paid.
    render(panel({ checkPaid: async () => answers.shift() ?? "paid", onPaid }));
    await advance(0);
    await payWithOpenWindow(100);
    answers.length = 0;
    answers.push("paid");
    fireEvent.click(payButton());
    await advance(0);
    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(whop.submit).toHaveBeenCalledTimes(1);
  });

  it("a retry that ended in \"wait\" never stretches \"Pay another way\": in flight past the last submit's window counts as unpaid", async () => {
    const onCancel = vi.fn();
    // The status route keeps saying in flight (the retry's confirm() marked the session PAYING again).
    render(panel({ checkPaid: async () => "inFlight", onCancel }));
    await advance(0);
    await payWithOpenWindow(); // submitted at ~0 s, window closed at ~5.8 s
    fireEvent.click(payButton());
    await advance(2_000);
    expect(whop.submit).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("wc-paypal-wait")).toBeTruthy();
    await advance(17_000); // ~25 s: the retry's confirm() keeps the server "in flight" until ~38 s
    fireEvent.click(screen.getByText(L.paypalPayOther));
    fireEvent.click(screen.getByText(L.paypalConfirmYes));
    // Once the last submit is ~30 s old (its window closed ~10 s before): the switch, no "wait" at ~35 s.
    await advance(13_000);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("unpaid: submits again", async () => {
    render(panel({ checkPaid: async () => "unpaid" }));
    await advance(0);
    await payWithOpenWindow();
    fireEvent.click(payButton());
    await advance(400);
    expect(whop.submit).toHaveBeenCalledTimes(2);
  });
});

describe("PaymentPanel: a PayPal payment submitted again", () => {
  it("\"Continue with PayPal\" again restarts the background checks (they had stopped ~2 min after the first window)", async () => {
    const onPaid = vi.fn();
    let state: PaidCheck = "unpaid";
    const checkPaid = vi.fn(async () => state);
    render(panel({ checkPaid, onPaid }));
    await advance(0);
    await payWithOpenWindow();
    await advance(PENDING_POLL_AFTER_CLOSE_MS + PENDING_POLL_MS * 2);
    const stoppedAt = checkPaid.mock.calls.length;
    await advance(PENDING_POLL_MS * 3);
    expect(checkPaid.mock.calls.length).toBe(stoppedAt);
    // Still pending (unpaid): the retry submits again, and its payment is watched in the background.
    await payWithOpenWindow();
    expect(whop.submit).toHaveBeenCalledTimes(2);
    state = "paid";
    await advance(PENDING_POLL_MS * 2);
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it("a failed retry keeps the earlier payment pending (locked); a failed first submit leaves nothing pending", async () => {
    const locks: PanelLock[] = [];
    let fail = false;
    const confirm = vi.fn(async () => {
      if (fail) throw new Error("network");
      return { ok: true as const, buyer };
    });
    render(panel({ checkPaid: async () => "unpaid", confirm, onLockChange: (l) => locks.push(l) }));
    await advance(0);
    await payWithOpenWindow();
    expect(locks.at(-1)).toBe("pending");
    fail = true;
    fireEvent.click(payButton());
    await advance(0);
    expect(screen.getByRole("alert").textContent).toContain("network");
    expect(locks.at(-1)).toBe("pending");
    cleanup();

    // Nothing pending before: a submit that throws unlocks.
    const locks2: PanelLock[] = [];
    whop.submit.mockRejectedValueOnce(new Error("boom"));
    render(panel({ checkPaid: async () => "unpaid", onLockChange: (l) => locks2.push(l) }));
    await advance(0);
    fireEvent.click(payButton());
    await advance(0);
    expect(screen.getByRole("alert").textContent).toContain("boom");
    expect(locks2.at(-1)).toBeNull();
  });

  it("PayPal refused at pay time under a pending payment: stays chosen and pending until the panel unlocks", async () => {
    const onCancel = vi.fn();
    let refuse = false;
    // The checkout page's confirm() on "paypal_unavailable" (CheckoutView): no longer offered, and
    // stopped only when the panel isn't locked; the render-time drop does the rest on unlock.
    function Harness() {
      const [mode, setMode] = useState(true);
      const [offered, setOffered] = useState(true);
      const [lock, setLock] = useState<PanelLock>(null);
      const lockRef = useRef<PanelLock>(null);
      useEffect(() => {
        lockRef.current = lock;
      }, [lock]);
      if (mode && !offered && lock === null) setMode(false);
      const confirm = async () => {
        if (!refuse) return { ok: true as const, buyer };
        setOffered(false);
        if (lockRef.current === null) setMode(false);
        return { ok: false as const, error: "PayPal indisponible" };
      };
      return h("div", null, panel({ checkPaid: async () => "unpaid", confirm, onLockChange: setLock, active: paypalStaysChosen({ mode, offered, lock }), onCancel: () => (onCancel(), setMode(false)) }));
    }
    render(h(Harness));
    await advance(0);
    await payWithOpenWindow();
    // "Continue with PayPal" again: Whop refuses PayPal now. The earlier payment may still go through.
    refuse = true;
    fireEvent.click(payButton());
    await advance(0);
    expect(whop.submit).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("wc-paypal-selected")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("PayPal indisponible");
    // Left through "Pay another way" (closed, unpaid after the checks): dropped, card form back.
    fireEvent.click(screen.getByText(L.paypalPayOther));
    fireEvent.click(screen.getByText(L.paypalConfirmYes));
    await advance(12_000);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("wc-paypal-selected")).toBeNull();
  });
});

describe("PaymentPanel: Whop's own PayPal button while a payment is pending", () => {
  it("an arming older than ~3 s opens nothing (a later tab switch with the focus left in the embed)", async () => {
    const locks: PanelLock[] = [];
    render(panel({ onLockChange: (l) => locks.push(l), checkPaid: async () => "unpaid" }));
    await advance(0);
    fireEvent.click(payButton());
    await advance(3_500);
    const iframe = screen.getByTestId("whop-paypal-button");
    act(() => {
      iframe.focus();
      window.dispatchEvent(new Event("blur"));
    });
    await advance(4_000);
    paypalWindow(true);
    await advance(400);
    expect(locks.at(-1)).toBeNull();
  });

  it("a second click on Whop's button once back from the first window is a new submit: checks start over", async () => {
    const locks: PanelLock[] = [];
    const onPaid = vi.fn();
    const onWhopWindow = vi.fn();
    let state: PaidCheck = "unpaid";
    const checkPaid = vi.fn(async () => state);
    render(panel({ onLockChange: (l) => locks.push(l), checkPaid, onPaid, onWhopWindow }));
    await advance(0);
    fireEvent.click(payButton());
    await advance(3_500);
    // A real click on Whop's button moves the focus into its iframe, and that blurs the page. A
    // browser fires no such blur when the iframe already has the focus: the click is simulated only
    // from outside it (focus moving in, then a fresh blur).
    const clickWhop = async () => {
      const iframe = screen.getByTestId("whop-paypal-button");
      expect(document.activeElement).not.toBe(iframe);
      act(() => {
        iframe.focus();
        window.dispatchEvent(new Event("blur"));
      });
      await advance(0);
      paypalWindow(true);
      await advance(400);
    };
    await clickWhop();
    expect(locks.at(-1)).toBe("pending");
    // The server is told (Whop's button submits without our confirm()): in flight for the status route.
    expect(onWhopWindow).toHaveBeenCalledTimes(1);
    await advance(5_000);
    paypalWindow(false);
    await advance(400);
    // Back from the window: the focus left the iframe for the embed's box (so the next click blurs).
    const iframe = screen.getByTestId("whop-paypal-button");
    expect(document.activeElement).not.toBe(iframe);
    expect(document.activeElement).toBe(iframe.closest("[tabindex='-1']"));
    // The checks stop ~2 min after that window closed with the session unpaid.
    await advance(PENDING_POLL_AFTER_CLOSE_MS + PENDING_POLL_MS * 2);
    const stoppedAt = checkPaid.mock.calls.length;
    await advance(PENDING_POLL_MS * 3);
    expect(checkPaid.mock.calls.length).toBe(stoppedAt);
    // Clicked again: watched again, and the background checks resume for this payment.
    await clickWhop();
    expect(onWhopWindow).toHaveBeenCalledTimes(2);
    state = "paid";
    await advance(PENDING_POLL_MS * 2);
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it("Whop's button opening PayPal while \"Continue with PayPal\"'s window is watched: that newer payment stays pending", async () => {
    const locks: PanelLock[] = [];
    const onWhopWindow = vi.fn();
    render(panel({ onLockChange: (l) => locks.push(l), checkPaid: async () => "unpaid", onWhopWindow }));
    await advance(0);
    // First window blocked: Whop's button shows.
    fireEvent.click(payButton());
    await advance(3_500);
    expect(screen.getByTestId("wc-paypal-popup-hint")).toBeTruthy();
    // "Continue with PayPal" again (its window blocked too), and within its grace the buyer clicks
    // Whop's button, whose window opens: the watch of our submit is superseded (aborted).
    fireEvent.click(payButton());
    await advance(0);
    act(() => {
      screen.getByTestId("whop-paypal-button").focus();
      window.dispatchEvent(new Event("blur"));
    });
    await advance(0);
    paypalWindow(true);
    await advance(400);
    expect(onWhopWindow).toHaveBeenCalledTimes(1);
    await advance(3_000);
    // Never read as "blocked": Whop's payment stays pending (locked), the Pay button is released.
    expect(locks.at(-1)).toBe("pending");
    expect(payButton().disabled).toBe(false);
    expect(payButton().textContent).not.toBe(L.paymentProcessing);
  });

  it("a new click on Whop's button during \"Pay another way\"'s checks: wait, never a switch under it", async () => {
    const onCancel = vi.fn();
    render(panel({ checkPaid: async () => "unpaid", onCancel }));
    await advance(0);
    fireEvent.click(payButton());
    await advance(3_500);
    const clickWhop = async () => {
      act(() => {
        screen.getByTestId("whop-paypal-button").focus();
        window.dispatchEvent(new Event("blur"));
      });
      await advance(0);
      paypalWindow(true);
      await advance(400);
    };
    await clickWhop();
    await advance(5_000);
    paypalWindow(false);
    await advance(400);
    // "Pay another way" → closed: the checks run (~10 s after that window)...
    fireEvent.click(screen.getByText(L.paypalPayOther));
    fireEvent.click(screen.getByText(L.paypalConfirmYes));
    await advance(1_000);
    // ...and meanwhile the buyer opens PayPal again from Whop's button: a new payment.
    await clickWhop();
    await advance(15_000);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByTestId("wc-paypal-wait").textContent).toBe(L.paypalPaymentInFlight);
  });
});

describe("PaymentPanel: a failed PayPal re-submit and a switch", () => {
  it("a re-submit that throws puts back the earlier payment's timings: the next retry isn't locked out", async () => {
    let state: PaidCheck = "unpaid";
    render(panel({ checkPaid: async () => state }));
    await advance(0);
    await payWithOpenWindow();
    await advance(31_000);
    // "Continue with PayPal" again: unpaid, submitted, but Whop's submit throws.
    whop.submit.mockRejectedValueOnce(new Error("boom"));
    fireEvent.click(payButton());
    await advance(0);
    expect(screen.getByRole("alert").textContent).toContain("boom");
    expect(whop.submit).toHaveBeenCalledTimes(2);
    // The server still sees that click's confirm() in flight. The earlier payment's window closed
    // and its submit are long past: this retry goes through (reset timings would mean wait).
    state = "inFlight";
    await advance(11_000);
    whop.submit.mockImplementationOnce(async () => paypalWindow(true));
    fireEvent.click(payButton());
    await advance(400);
    expect(whop.submit).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("wc-paypal-wait")).toBeNull();
  });

  it("after a switch the focus lands on the Pay button (\"Pay another way\" is gone)", async () => {
    function Harness() {
      const [active, setActive] = useState(true);
      return panel({ checkPaid: async () => "unpaid", active, onCancel: () => setActive(false) });
    }
    render(h(Harness));
    await advance(0);
    await payWithOpenWindow();
    fireEvent.click(screen.getByText(L.paypalPayOther));
    await advance(0);
    fireEvent.click(screen.getByText(L.paypalConfirmYes));
    await advance(12_000);
    expect(screen.queryByTestId("wc-paypal-selected")).toBeNull();
    expect(document.activeElement).toBe(payButton());
  });
});

describe("PaymentPanel: server wait (another payment of the session in flight)", () => {
  it("pay refused with payment_in_flight: a wait (not an error), status polled, the card retry allowed once unpaid", async () => {
    const answers: PaidCheck[] = ["inFlight", "unpaid"];
    const checkPaid = vi.fn(async () => answers.shift() ?? "unpaid");
    const confirm = vi
      .fn<ComponentProps<typeof PaymentPanel>["confirm"]>()
      .mockResolvedValueOnce({ ok: false, error: L.paymentAlreadyInFlight, inFlight: true })
      .mockResolvedValue({ ok: true, buyer });
    const locks: PanelLock[] = [];
    render(panel({ active: false, checkPaid, confirm, onLockChange: (l) => locks.push(l) }));
    await advance(10);
    fireEvent.click(payButton());
    await advance(10);
    expect(screen.getByTestId("wc-inflight-wait").textContent).toBe(L.paymentAlreadyInFlight);
    expect(screen.getByTestId("wc-paypal-live").textContent).toBe(L.paymentAlreadyInFlight);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(payButton().getAttribute("aria-disabled")).toBe("true");
    // Pay says why it is unavailable: the wait's own line.
    expect(payButton().getAttribute("aria-describedby")?.split(" ")).toContain("wc-inflight-wait");
    expect(document.getElementById("wc-inflight-wait")?.textContent).toBe(L.paymentAlreadyInFlight);
    expect(locks.at(-1)).toBe("busy");
    // A click meanwhile submits nothing.
    fireEvent.click(payButton());
    await advance(10);
    expect(confirm).toHaveBeenCalledTimes(1);
    // Polled: still in flight, then unpaid → the wait ends and the card can be paid again.
    await advance(SERVER_WAIT_POLL_MS);
    expect(screen.getByTestId("wc-inflight-wait")).toBeTruthy();
    await advance(SERVER_WAIT_POLL_MS);
    expect(checkPaid).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("wc-inflight-wait")).toBeNull();
    expect(locks.at(-1)).toBeNull();
    // Pay usable again, and announced (politely), no longer described by the gone wait line.
    expect(payButton().getAttribute("aria-disabled")).toBe("false");
    expect(payButton().getAttribute("aria-describedby") ?? "").not.toMatch(/wc-inflight-wait/);
    expect(screen.getByTestId("wc-paypal-live").textContent).toBe(L.payNowAvailable);
    expect(L.payNowAvailable).toBe("Vous pouvez payer maintenant.");
    fireEvent.click(payButton());
    await advance(10);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(whop.submit).toHaveBeenCalledTimes(1);
    // The next submit clears the announcement.
    expect(screen.getByTestId("wc-paypal-live").textContent).toBe("");
  });

  it("\"You can pay now\" exists in every checkout language", () => {
    for (const [lang, labels] of Object.entries(LABELS)) {
      expect(labels.payNowAvailable, lang).toBeTruthy();
      if (lang !== "fr") expect(labels.payNowAvailable, lang).not.toBe(L.payNowAvailable);
    }
  });

  it("in flight as the page loads (second tab, reload): starts in the wait; paid meanwhile → thank-you page", async () => {
    const checkPaid = vi.fn(async (): Promise<PaidCheck> => "paid");
    const onPaid = vi.fn();
    const { rerender } = render(panel({ active: false, checkPaid, onPaid }));
    expect(screen.queryByTestId("wc-inflight-wait")).toBeNull();
    // The page's status check answers after mount.
    rerender(h(PaymentPanel, { ...panel({ active: false, checkPaid, onPaid }).props, inFlightAtLoad: true }));
    expect(screen.getByTestId("wc-inflight-wait")).toBeTruthy();
    await advance(SERVER_WAIT_POLL_MS);
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it("bounded: never past the server's in-flight window (failed checks included)", () => {
    expect(serverWaitNext("unpaid", 0)).toBeNull();
    expect(serverWaitNext("inFlight", 0)).toBe(SERVER_WAIT_POLL_MS);
    expect(serverWaitNext("unknown", PAYPAL_SERVER_IN_FLIGHT_MS)).toBe(SERVER_WAIT_POLL_MS);
    expect(serverWaitNext("inFlight", PAYPAL_SERVER_IN_FLIGHT_MS + 1)).toBeNull();
  });
});

describe("PaymentPanel: a PayPal popup opening late (after the \"blocked\" verdict)", () => {
  it("blocked at ~2.5 s, focus lost at 4 s: pending again (locked), a beat (never a new window stamp), Whop's button hidden; closed once", async () => {
    const locks: PanelLock[] = [];
    const onWhopWindow = vi.fn();
    const onWindowBlocked = vi.fn();
    const onWindowBeat = vi.fn();
    const onWindowClosed = vi.fn();
    render(panel({ onLockChange: (l) => locks.push(l), checkPaid: async () => "unpaid", onWhopWindow, onWindowBlocked, onWindowBeat, onWindowClosed }));
    await advance(0);
    fireEvent.click(payButton());
    await advance(2_700);
    expect(onWindowBlocked).toHaveBeenCalledTimes(1);
    expect(locks.at(-1)).toBeNull();
    expect(screen.getByTestId("wc-paypal-popup-hint")).toBeTruthy();
    expect(screen.getByTestId("whop-paypal-button")).toBeTruthy();
    await advance(1_300);
    // The slow popup takes the focus now (focus on our own button, not in the embed; page visible).
    paypalWindow(true);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    await advance(600);
    expect(locks.at(-1)).toBe("pending");
    // Liveness only: the confirm's click stays the attempt its failure webhook is matched to.
    expect(onWindowBeat).toHaveBeenCalledTimes(1);
    expect(onWhopWindow).not.toHaveBeenCalled();
    expect(screen.queryByTestId("wc-paypal-popup-hint")).toBeNull();
    // No second PayPal window next to ours: Whop's own button is gone while this one is pending.
    expect(screen.queryByTestId("whop-paypal-button")).toBeNull();
    expect(onWindowClosed).not.toHaveBeenCalled();
    // Closed: still pending ("Pay another way" asks first), the server told once, no more beats.
    paypalWindow(false);
    await advance(400);
    expect(locks.at(-1)).toBe("pending");
    expect(onWindowClosed).toHaveBeenCalledTimes(1);
    await advance(PAYPAL_HEARTBEAT_MS * 3);
    expect(onWindowBeat).toHaveBeenCalledTimes(1);
    expect(onWhopWindow).not.toHaveBeenCalled();
    expect(screen.queryByTestId("whop-paypal-button")).toBeNull();
  });

  it("past the server's in-flight window, or once PayPal is dropped, a focus loss is no late popup", async () => {
    const locks: PanelLock[] = [];
    const onWhopWindow = vi.fn();
    const onWindowBeat = vi.fn();
    const { rerender } = render(panel({ onLockChange: (l) => locks.push(l), checkPaid: async () => "unpaid", onWhopWindow, onWindowBeat }));
    await advance(0);
    fireEvent.click(payButton());
    await advance(2_700 + PAYPAL_SERVER_IN_FLIGHT_MS + 200);
    paypalWindow(true);
    await advance(400);
    expect(locks.at(-1)).toBeNull();
    expect(onWindowBeat).not.toHaveBeenCalled();
    paypalWindow(false);
    // Blocked again, then back to the card: a focus loss (e.g. the card's 3-D Secure) changes nothing.
    fireEvent.click(payButton());
    await advance(2_700);
    rerender(panel({ onLockChange: (l) => locks.push(l), checkPaid: async () => "unpaid", onWhopWindow, onWindowBeat, active: false }));
    await advance(0);
    paypalWindow(true);
    await advance(1_000);
    expect(locks.at(-1)).toBeNull();
    expect(onWindowBeat).not.toHaveBeenCalled();
    expect(onWhopWindow).not.toHaveBeenCalled();
  });

  it("a tab switch (page hidden) within the watch is no late popup; a popup in front of the visible page after it is", async () => {
    const locks: PanelLock[] = [];
    const onWindowBeat = vi.fn();
    render(panel({ onLockChange: (l) => locks.push(l), checkPaid: async () => "unpaid", onWindowBeat }));
    await advance(0);
    fireEvent.click(payButton());
    await advance(2_700);
    // Tab switch: blurred then hidden (a moment apart, as in a browser), for a few seconds.
    paypalWindow(true);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    await advance(100);
    tabSwitch(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(3_000);
    expect(locks.at(-1)).toBeNull();
    expect(onWindowBeat).not.toHaveBeenCalled();
    tabSwitch(false);
    await advance(1_000);
    expect(locks.at(-1)).toBeNull();
    // The popup opening late, in front of the visible page: pending.
    paypalWindow(true);
    await advance(600);
    expect(locks.at(-1)).toBe("pending");
    expect(onWindowBeat).toHaveBeenCalledTimes(1);
  });
});

describe("PaymentPanel: heartbeat of an open PayPal window", () => {
  it("every ~20 s while the window is open (beats only, never a window stamp); closed once; none after, even away again", async () => {
    const onWhopWindow = vi.fn();
    const onWindowBeat = vi.fn();
    const onWindowClosed = vi.fn();
    render(panel({ checkPaid: async () => "unpaid", onWhopWindow, onWindowBeat, onWindowClosed }));
    await advance(0);
    whop.submit.mockImplementationOnce(async () => {
      paypalWindow(true);
    });
    fireEvent.click(payButton());
    await advance(400);
    await advance(PAYPAL_HEARTBEAT_MS);
    expect(onWindowBeat).toHaveBeenCalledTimes(1);
    await advance(PAYPAL_HEARTBEAT_MS * 2);
    expect(onWindowBeat).toHaveBeenCalledTimes(3);
    expect(onWhopWindow).not.toHaveBeenCalled();
    expect(onWindowClosed).not.toHaveBeenCalled();
    // Back on the page (window closed): the server told once, no more beats.
    paypalWindow(false);
    await advance(400);
    expect(onWindowClosed).toHaveBeenCalledTimes(1);
    await advance(PAYPAL_HEARTBEAT_MS * 3);
    expect(onWindowBeat).toHaveBeenCalledTimes(3);
    // The page away again later (another tab, another window): still no beat once closed.
    paypalWindow(true);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    await advance(PAYPAL_HEARTBEAT_MS * 3);
    expect(onWindowBeat).toHaveBeenCalledTimes(3);
    expect(onWindowClosed).toHaveBeenCalledTimes(1);
  });

  it("a window that closes before any beat sends no \"closed\"", async () => {
    const onWindowBeat = vi.fn();
    const onWindowClosed = vi.fn();
    render(panel({ checkPaid: async () => "unpaid", onWindowBeat, onWindowClosed }));
    await advance(0);
    await payWithOpenWindow(5_000);
    expect(onWindowBeat).not.toHaveBeenCalled();
    expect(onWindowClosed).not.toHaveBeenCalled();
  });

  it("\"Yes, it's closed\" tells the server (once: the window's own close later sends nothing more)", async () => {
    const onWindowBeat = vi.fn();
    const onWindowClosed = vi.fn();
    render(panel({ checkPaid: async () => "unpaid", onWindowBeat, onWindowClosed }));
    await advance(0);
    // A window from Whop's own button (after a blocked one), beating.
    fireEvent.click(payButton());
    await advance(3_500);
    const iframe = screen.getByTestId("whop-paypal-button");
    act(() => {
      iframe.focus();
      window.dispatchEvent(new Event("blur"));
    });
    await advance(0);
    paypalWindow(true);
    await advance(400);
    await advance(PAYPAL_HEARTBEAT_MS);
    expect(onWindowBeat).toHaveBeenCalledTimes(1);
    // The buyer answers while the page is still seen away (the close not detected yet).
    fireEvent.click(screen.getByText(L.paypalPayOther));
    await advance(0);
    fireEvent.click(screen.getByText(L.paypalConfirmYes));
    expect(onWindowClosed).toHaveBeenCalledTimes(1);
    paypalWindow(false);
    await advance(400);
    expect(onWindowClosed).toHaveBeenCalledTimes(1);
  });

  it("Whop's own button: one window stamp (onWhopWindow), then beats only", async () => {
    const onWhopWindow = vi.fn();
    const onWindowBeat = vi.fn();
    const onWindowClosed = vi.fn();
    render(panel({ checkPaid: async () => "unpaid", onWhopWindow, onWindowBeat, onWindowClosed }));
    await advance(0);
    fireEvent.click(payButton());
    await advance(3_500);
    const iframe = screen.getByTestId("whop-paypal-button");
    act(() => {
      iframe.focus();
      window.dispatchEvent(new Event("blur"));
    });
    await advance(0);
    paypalWindow(true);
    await advance(400);
    expect(onWhopWindow).toHaveBeenCalledTimes(1);
    await advance(PAYPAL_HEARTBEAT_MS * 2);
    expect(onWhopWindow).toHaveBeenCalledTimes(1);
    expect(onWindowBeat).toHaveBeenCalledTimes(2);
    paypalWindow(false);
    await advance(400);
    expect(onWindowClosed).toHaveBeenCalledTimes(1);
  });

  it("never before the window opened (a blocked one: none), bounded to ~10 min, over at unmount", async () => {
    const onWhopWindow = vi.fn();
    render(panel({ checkPaid: async () => "unpaid", onWindowBeat: onWhopWindow }));
    await advance(0);
    // A window that never took the focus: nothing sent.
    fireEvent.click(payButton());
    await advance(400);
    await advance(PAYPAL_HEARTBEAT_MS * 2);
    expect(onWhopWindow).not.toHaveBeenCalled();
    // One left open for good: beats until ~10 min, then none.
    whop.submit.mockImplementationOnce(async () => {
      paypalWindow(true);
    });
    fireEvent.click(payButton());
    await advance(400);
    await advance(PAYPAL_WINDOW_MAX_MS + PAYPAL_HEARTBEAT_MS * 5);
    const beats = onWhopWindow.mock.calls.length;
    expect(beats).toBe(Math.ceil(PAYPAL_WINDOW_MAX_MS / PAYPAL_HEARTBEAT_MS) - 1);
    await advance(PAYPAL_HEARTBEAT_MS * 5);
    expect(onWhopWindow).toHaveBeenCalledTimes(beats);
    cleanup();
    whop.submit.mockReset().mockResolvedValue(undefined);
    // Unmounted mid-window: stops.
    const again = vi.fn();
    const r = render(panel({ checkPaid: async () => "unpaid", onWindowBeat: again }));
    await advance(0);
    paypalWindow(false);
    whop.submit.mockImplementationOnce(async () => {
      paypalWindow(true);
    });
    fireEvent.click(payButton());
    await advance(400);
    await advance(PAYPAL_HEARTBEAT_MS);
    expect(again).toHaveBeenCalledTimes(1);
    r.unmount();
    await advance(PAYPAL_HEARTBEAT_MS * 3);
    expect(again).toHaveBeenCalledTimes(1);
  });
});

describe("PaymentPanel: server wait right after a declined card", () => {
  it("says the card was declined and a retry is possible in a few seconds (within 30 s of the decline only)", async () => {
    const confirm = vi
      .fn<ComponentProps<typeof PaymentPanel>["confirm"]>()
      .mockResolvedValueOnce({ ok: true, buyer })
      .mockResolvedValue({ ok: false, error: L.paymentAlreadyInFlight, inFlight: true });
    const checkPaid = vi.fn(async (): Promise<PaidCheck> => "inFlight");
    const { rerender } = render(panel({ active: false, confirm, checkPaid }));
    await advance(10);
    fireEvent.click(payButton());
    await advance(10);
    expect(whop.submit).toHaveBeenCalledTimes(1);
    // The bank declines the card.
    act(() => whop.last?.onPaymentError?.({ message: "Carte refusée" }));
    // Straight to PayPal: the server still counts the card attempt in flight.
    rerender(panel({ active: true, confirm, checkPaid }));
    await advance(10);
    fireEvent.click(payButton());
    await advance(10);
    expect(screen.getByTestId("wc-inflight-wait").textContent).toBe(L.cardDeclinedRetrySoon);
    expect(screen.getByTestId("wc-paypal-live").textContent).toBe(L.cardDeclinedRetrySoon);
    expect(L.cardDeclinedRetrySoon).toBe("Votre paiement par carte a été refusé ; vous pourrez réessayer dans quelques secondes.");
    // The wait ends (bounded); a refusal long after the decline is the generic wait.
    await advance(PAYPAL_SERVER_IN_FLIGHT_MS + SERVER_WAIT_POLL_MS * 2);
    expect(screen.queryByTestId("wc-inflight-wait")).toBeNull();
    await advance(CARD_DECLINED_RECENT_MS);
    fireEvent.click(payButton());
    await advance(10);
    expect(screen.getByTestId("wc-inflight-wait").textContent).toBe(L.paymentAlreadyInFlight);
  });

  it("exists in every checkout language", () => {
    for (const [lang, labels] of Object.entries(LABELS)) {
      expect(labels.cardDeclinedRetrySoon, lang).toBeTruthy();
      if (lang !== "fr") expect(labels.cardDeclinedRetrySoon, lang).not.toBe(L.cardDeclinedRetrySoon);
    }
  });
});

describe("ExpressCheckout lock", () => {
  it("inert grid plus a visible, polite line while a PayPal payment is pending; nothing while unlocked", () => {
    const props = {
      prepared: { configId: "cfg_card", environment: "sandbox" as const },
      theme,
      labels: L,
      returnUrl: "https://x.test/merci",
      email: "",
      onPaid: () => undefined,
      paypal: { onClick: () => undefined, busy: false },
    };
    const { rerender } = render(h(ExpressCheckout, { ...props, lock: "pending" }));
    const line = screen.getByTestId("wc-express-locked");
    expect(line.textContent).toBe(L.paypalExpressLocked);
    expect(line.getAttribute("aria-live")).toBe("polite");
    const grid = screen.getByTestId("wc-paypal-express").closest("[inert]");
    expect(grid).toBeTruthy();
    expect(grid?.hasAttribute("aria-disabled")).toBe(false);
    rerender(h(ExpressCheckout, { ...props, lock: null }));
    expect(screen.getByTestId("wc-express-locked").textContent).toBe("");
    expect(screen.getByTestId("wc-paypal-express").closest("[inert]")).toBeNull();
  });
});
