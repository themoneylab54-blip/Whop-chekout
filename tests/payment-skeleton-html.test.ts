import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PAYMENT_SKELETON_HTML, PaymentSkeleton } from "@/components/checkout/Payment";

/*
 * The payment form's skeleton written out as HTML (PAYMENT_SKELETON_HTML, for the page's HTML before
 * React runs) is PaymentSkeleton's own markup, to the character: whichever of the two is on screen,
 * the buyer sees the same skeleton, and nothing moves when one replaces the other.
 */

describe("PAYMENT_SKELETON_HTML", () => {
  it("is PaymentSkeleton rendered to static markup, exactly", () => {
    expect(
      renderToStaticMarkup(createElement(PaymentSkeleton)),
      "PaymentSkeleton and PAYMENT_SKELETON_HTML (Payment.tsx) change together: write PaymentSkeleton's new markup (renderToStaticMarkup) into PAYMENT_SKELETON_HTML",
    ).toBe(PAYMENT_SKELETON_HTML);
  });
});
