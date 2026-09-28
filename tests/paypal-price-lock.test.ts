// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/*
 * The checkout page while a PayPal payment is pending (the payment panel's lock "pending"): every
 * input that changes the price is read-only or disabled, and so is every delivery and contact
 * field (the order is made from them), each pointing at a short note (aria-describedby).
 * The payment panel is stubbed (it only reports its lock); Whop's embed is never loaded.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));
vi.mock("@whop/checkout/react", () => ({
  WhopCheckoutEmbed: () => null,
  WhopExpressCheckoutButton: () => null,
  useCheckoutEmbedControls: () => ({ current: null }),
}));
const stub = vi.hoisted(() => ({
  onLockChange: null as ((l: "pending" | "busy" | null) => void) | null,
  inFlightAtLoad: undefined as boolean | undefined,
  paypalActive: undefined as boolean | undefined,
  onWindowBlocked: undefined as (() => void) | undefined,
  onWindowBeat: undefined as (() => void) | undefined,
  onWindowClosed: undefined as (() => void) | undefined,
}));
vi.mock("@/components/checkout/Payment", async (orig) => {
  const actual = await orig<typeof import("@/components/checkout/Payment")>();
  return {
    ...actual,
    PaymentPanel: (p: { onLockChange?: (l: "pending" | "busy" | null) => void; inFlightAtLoad?: boolean; paypal?: { active: boolean; onWindowBlocked?: () => void; onWindowBeat?: () => void; onWindowClosed?: () => void } }) => {
      stub.onLockChange = p.onLockChange ?? null;
      stub.inFlightAtLoad = p.inFlightAtLoad;
      stub.paypalActive = p.paypal?.active;
      stub.onWindowBlocked = p.paypal?.onWindowBlocked;
      stub.onWindowBeat = p.paypal?.onWindowBeat;
      stub.onWindowClosed = p.paypal?.onWindowClosed;
      return null;
    },
  };
});

const { CheckoutView } = await import("@/components/checkout/CheckoutView");
const { createBlock, defaultCheckoutLayout, defaultTheme } = await import("@/lib/layout");
const { PickupPicker } = await import("@/components/checkout/PickupPicker");
const { SAMPLE_LINES } = await import("@/lib/sample");
const { LABELS } = await import("@/components/checkout/i18n");
const L = LABELS.fr;

function page(extra: { note?: boolean } = {}) {
  const layout = defaultCheckoutLayout();
  if (extra.note) {
    const at = layout.blocks.findIndex((b) => b.type === "payment");
    layout.blocks.splice(at, 0, createBlock("order_note"));
  }
  const props: ComponentProps<typeof CheckoutView> = {
    theme: { ...defaultTheme("Boutique"), language: "fr" },
    layout,
    currency: "EUR",
    lines: SAMPLE_LINES,
    rates: [{ id: "r1", name: "Colissimo", deliveryTime: null, countries: ["FR", "BE"], priceCents: 490, freeOverCents: null, active: true, kind: "standard" } as ComponentProps<typeof CheckoutView>["rates"][number]],
    addOns: [{ id: "a1", title: "Emballage cadeau", description: null, priceCents: 300, imageUrl: null }],
    initialEligibleAddOnIds: ["a1"],
    hasDiscounts: true,
    mode: { kind: "live", sessionId: "s_lock", testMode: false },
    initialCountry: "FR",
  };
  return h(CheckoutView, props);
}

beforeEach(() => {
  stub.onLockChange = null;
  stub.inFlightAtLoad = undefined;
  // Nothing answers (quote, progress…): the page renders from its props alone.
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CheckoutView while a PayPal payment is pending", () => {
  it("price-affecting inputs are read-only with a note; contact stays editable; unlocked again after", () => {
    const { container } = render(page());
    const country = () => container.querySelector("select[autocomplete='country']") as HTMLSelectElement;
    const byAuto = (a: string) => container.querySelector(`input[autocomplete='${a}']`) as HTMLInputElement;
    const rate = () => container.querySelector("input[name='rate']") as HTMLInputElement | null;
    const checkboxes = () => [...container.querySelectorAll<HTMLInputElement>("input[type='checkbox']")].filter((c) => c.closest("label")?.textContent?.includes("Emballage cadeau"));
    const steppers = () => [...container.querySelectorAll<HTMLButtonElement>("button")].filter((b) => /quantité|Augmenter|Diminuer/i.test(b.getAttribute("aria-label") ?? ""));
    const promo = () => [...container.querySelectorAll<HTMLInputElement>("input")].filter((i) => (i.id ?? "").endsWith("discount") || /code/i.test(i.getAttribute("placeholder") ?? "") || /code/i.test(i.getAttribute("aria-label") ?? ""));

    expect(screen.queryAllByTestId("wc-price-locked")).toHaveLength(0);
    expect(country().disabled).toBe(false);
    expect(byAuto("postal-code").readOnly).toBe(false);
    expect(stub.onLockChange).toBeTypeOf("function");

    act(() => stub.onLockChange!("pending"));
    const notes = screen.getAllByTestId("wc-price-locked");
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) expect(n.textContent).toBe(L.paypalEditsLocked);
    // The country: locked like a read-only field, not disabled (still focusable, the lock note
    // announced with it); a change (keyboard arrows on the closed select) is not taken.
    expect(country().disabled).toBe(false);
    expect(country().getAttribute("aria-disabled")).toBe("true");
    expect((country().getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent)).toContain(L.paypalEditsLocked);
    const otherCountry = [...country().options].map((o) => o.value).find((v) => v !== "FR");
    expect(otherCountry).toBeTruthy();
    act(() => {
      fireEvent.change(country(), { target: { value: otherCountry } });
    });
    expect(country().value).toBe("FR");
    for (const a of ["postal-code", "address-level2"]) expect(byAuto(a).readOnly).toBe(true);
    // The quote's address line: read-only too (the autocomplete's own input).
    expect(byAuto("address-line1").readOnly).toBe(true);
    // Every kind is on the page (none of the checks below is vacuous).
    expect({ rate: !!rate(), addOns: checkboxes().length, steppers: steppers().length, promo: promo().length > 0 }).toEqual({ rate: true, addOns: 1, steppers: 4, promo: true });
    // Every delivery and contact field too (the order is made from what PayPal was opened with),
    // each pointing at its section's lock note.
    for (const a of ["email", "given-name", "family-name", "address-line1", "address-line2", "postal-code", "address-level2", "tel"]) {
      const input = byAuto(a);
      expect(input.readOnly, a).toBe(true);
      const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
      const note = ids.map((id) => document.getElementById(id)).find((el) => el?.dataset.testid === "wc-price-locked");
      expect(note?.textContent, a).toBe(L.paypalEditsLocked);
    }
    expect(L.paypalEditsLocked).toBe("Paiement PayPal en cours : vos informations sont verrouillées");
    expect(rate()!.disabled).toBe(true);
    for (const c of checkboxes()) expect(c.disabled).toBe(true);
    for (const b of steppers()) expect(b.disabled).toBe(true);
    for (const i of promo()) expect(i.disabled || i.readOnly).toBe(true);
    // The marketing and remember-me boxes (saved with the pending payment): locked, focusable,
    // pointing at the contact lock note; a click doesn't toggle them.
    for (const id of ["wc-marketing", "wc-remember"]) {
      const box = screen.getByTestId(id) as HTMLInputElement;
      expect(box.getAttribute("aria-disabled"), id).toBe("true");
      expect(box.disabled, id).toBe(false);
      expect((box.getAttribute("aria-describedby") ?? "").split(" ").map((x) => document.getElementById(x)?.textContent), id).toContain(L.paypalEditsLocked);
      const before = box.checked;
      act(() => {
        fireEvent.click(box);
      });
      expect(box.checked, id).toBe(before);
    }

    // "busy" (a card payment submitting) locks nothing here; nor does the lock once released.
    act(() => stub.onLockChange!("busy"));
    expect(screen.queryAllByTestId("wc-price-locked")).toHaveLength(0);
    act(() => stub.onLockChange!(null));
    expect(country().disabled).toBe(false);
    expect(country().hasAttribute("aria-disabled")).toBe(false);
    act(() => {
      fireEvent.change(country(), { target: { value: otherCountry } });
    });
    expect(country().value).toBe(otherCountry);
    act(() => {
      fireEvent.change(country(), { target: { value: "FR" } });
    });
    expect(country().value).toBe("FR");
    for (const id of ["wc-marketing", "wc-remember"]) {
      const box = screen.getByTestId(id) as HTMLInputElement;
      expect(box.hasAttribute("aria-disabled"), id).toBe(false);
      const before = box.checked;
      act(() => {
        fireEvent.click(box);
      });
      expect(box.checked, id).toBe(!before);
    }
    for (const a of ["email", "given-name", "family-name", "address-line1", "address-line2", "postal-code", "tel"]) {
      expect(byAuto(a).readOnly, a).toBe(false);
      expect(byAuto(a).getAttribute("aria-describedby") ?? "", a).not.toMatch(/wc-lock-/);
    }
    for (const b of steppers().filter((s) => /Augmenter/.test(s.getAttribute("aria-label") ?? ""))) expect(b.disabled).toBe(false);
    expect(rate()!.disabled).toBe(false);
    for (const c of checkboxes()) expect(c.disabled).toBe(false);
    for (const i of promo()) expect(i.disabled || i.readOnly).toBe(false);
  });

  it("a blocked PayPal window is reported to the paypal-window route as { blocked: true } (same-origin POST)", () => {
    render(page());
    expect(stub.onWindowBlocked).toBeTypeOf("function");
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();
    stub.onWindowBlocked!();
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/paypal-window"));
    expect(call?.[0]).toBe("/api/public/sessions/s_lock/paypal-window");
    expect(call?.[1]).toMatchObject({ method: "POST", keepalive: true });
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ blocked: true });
  });

  it("the window's heartbeat and close go to the paypal-window route as { beat: true } / { closed: true }", () => {
    render(page());
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    for (const [fn, body] of [
      [stub.onWindowBeat, { beat: true }],
      [stub.onWindowClosed, { closed: true }],
    ] as const) {
      expect(fn).toBeTypeOf("function");
      fetchMock.mockClear();
      fn!();
      const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/paypal-window"));
      expect(call?.[0]).toBe("/api/public/sessions/s_lock/paypal-window");
      expect(call?.[1]).toMatchObject({ method: "POST", keepalive: true, headers: { "Content-Type": "application/json" } });
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual(body);
    }
  });

  it("the order note is read-only too, pointing at the lock note", () => {
    const { container } = render(page({ note: true }));
    // Collapsed behind its link until the buyer opens it.
    const open = [...container.querySelectorAll("button")].find((b) => b.getAttribute("aria-expanded") === "false" && /précision/i.test(b.textContent ?? ""));
    act(() => open!.click());
    act(() => stub.onLockChange!("pending"));
    const note = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(note.readOnly).toBe(true);
    expect(document.getElementById(note.getAttribute("aria-describedby") ?? "")?.textContent).toBe(L.paypalEditsLocked);
    act(() => stub.onLockChange!(null));
    expect(note.readOnly).toBe(false);
    expect(note.hasAttribute("aria-describedby")).toBe(false);
  });

  it("the relay point can't be changed while locked (search read-only, « Changer » inert, described by the note)", () => {
    const point = { provider: "mondial_relay" as const, id: "p1", name: "Tabac", address1: "1 rue", zip: "75001", city: "Paris", countryCode: "FR" };
    const onChange = vi.fn();
    const props = { sessionId: "s", country: "FR", addressZip: "75001", addressCity: "Paris", value: point, onChange, L, lang: "fr" as const, inputId: "wc-pickup" };
    const { rerender } = render(h(PickupPicker, { ...props, lockedBy: "wc-lock-delivery" }));
    const change = document.getElementById("wc-pickup") as HTMLButtonElement;
    expect(change.getAttribute("aria-disabled")).toBe("true");
    expect(change.getAttribute("aria-describedby")).toBe("wc-lock-delivery");
    act(() => change.click());
    // Still the chosen point's summary: no search opened.
    expect(document.getElementById("wc-pickup")?.tagName).toBe("BUTTON");
    // No point chosen yet: the search is read-only and its button disabled.
    rerender(h(PickupPicker, { ...props, value: null, lockedBy: "wc-lock-delivery" }));
    const zip = document.getElementById("wc-pickup") as HTMLInputElement;
    expect(zip.readOnly).toBe(true);
    expect(zip.getAttribute("aria-describedby")).toContain("wc-lock-delivery");
    expect((zip.form?.querySelector("button[type='submit']") as HTMLButtonElement).disabled).toBe(true);
    rerender(h(PickupPicker, { ...props, value: null, lockedBy: null }));
    expect((document.getElementById("wc-pickup") as HTMLInputElement).readOnly).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a payment in flight as the page loads (status route): the payment panel starts in its wait", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        String(url).endsWith("/status")
          ? Promise.resolve(new Response(JSON.stringify({ status: "PAYING", paymentInFlight: true }), { status: 200 }))
          : new Promise(() => undefined),
      ),
    );
    render(page());
    expect(stub.inFlightAtLoad).toBe(false);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(stub.inFlightAtLoad).toBe(true);
  });

  it("PayPal withdrawn by a prepare's answer (async): dropped with the full reset when unlocked, kept under a pending payment", async () => {
    const { fireEvent } = await import("@testing-library/react");
    // The incomplete form scrolls to its first field (not in jsdom).
    Element.prototype.scrollIntoView = vi.fn();
    let paypalOn = true;
    const prepares: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (String(url).endsWith("/prepare")) {
          prepares.push(String(init?.body ?? ""));
          return Promise.resolve(new Response(JSON.stringify({ checkoutConfigurationId: `c${prepares.length}`, environment: "sandbox", paypal: paypalOn }), { status: 200 }));
        }
        return new Promise(() => undefined);
      }),
    );
    const flush = () =>
      act(async () => {
        // Past the prepare's debounce (500 ms).
        await new Promise((r) => setTimeout(r, 700));
      });
    const { container } = render(page());
    await flush();
    const express = () => screen.queryByTestId("wc-paypal-express");
    const country = () => container.querySelector("select[autocomplete='country']") as HTMLSelectElement;
    expect(express()).toBeTruthy();
    // PayPal chosen (form incomplete: its notice shows).
    act(() => (express()!.querySelector("button") ?? express()!).dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(stub.paypalActive).toBe(true);
    expect(screen.getByText(L.paypalNeedsDetails)).toBeTruthy();
    // The next prepare (another country) answers PayPal is off now, nothing pending: dropped, with
    // the full reset (its notice gone too), the button with it.
    paypalOn = false;
    fireEvent.change(country(), { target: { value: "BE" } });
    await flush();
    expect(prepares.length).toBeGreaterThanOrEqual(2);
    expect(stub.paypalActive).toBe(false);
    expect(express()).toBeNull();
    expect(screen.queryByText(L.paypalNeedsDetails)).toBeNull();
  });

  it("the async PayPal drops use the full reset (prepare signature forgotten), their message kept", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/components/checkout/CheckoutView.tsx"), "utf8");
    // No partial reset left (setPaypalMode(false) outside endPaypal).
    expect(src.match(/setPaypalMode\(false\)/g) ?? []).toHaveLength(0);
    expect(src.match(/endPaypal\(paypalChoiceReset\(\{ keepError: true \}\)\)/g)?.length).toBeGreaterThanOrEqual(3);
    // The PayPal prepare that dropped the choice doesn't record its signature afterwards.
    expect(src).toMatch(/if \(!dropped\) setPaypalDoneSig\(sig\)/);
  });

  it("nothing in flight at load: no wait", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        String(url).endsWith("/status")
          ? Promise.resolve(new Response(JSON.stringify({ status: "FAILED", paymentInFlight: false }), { status: 200 }))
          : new Promise(() => undefined),
      ),
    );
    render(page());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(stub.inFlightAtLoad).toBe(false);
  });
});
