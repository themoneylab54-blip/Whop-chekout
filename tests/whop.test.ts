import { describe, expect, it } from "vitest";
import { Webhook } from "standardwebhooks";
import { eventType, moneyToCents, verifyWhopWebhook } from "@/lib/whop";

const SECRET = "ws_test_secret_123";

function sign(body: string, id = "msg_1", ts = Math.floor(Date.now() / 1000)) {
  // Whop HMACs with the literal secret bytes; standardwebhooks base64-decodes its key.
  const wh = new Webhook(Buffer.from(SECRET).toString("base64"));
  const signature = wh.sign(id, new Date(ts * 1000), body);
  return new Headers({ "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": signature });
}

describe("verifyWhopWebhook", () => {
  const body = JSON.stringify({ type: "payment.succeeded", data: { id: "pay_1", metadata: { checkout_session_id: "s1" } } });

  it("accepts a correctly signed payload", () => {
    const evt = verifyWhopWebhook(body, sign(body), SECRET);
    expect(evt.type).toBe("payment.succeeded");
    expect(evt.data?.id).toBe("pay_1");
  });

  it("rejects a modified body, a wrong secret and stale timestamps", () => {
    expect(() => verifyWhopWebhook(body.replace("pay_1", "pay_2"), sign(body), SECRET)).toThrow();
    expect(() => verifyWhopWebhook(body, sign(body), "ws_other")).toThrow();
    expect(() => verifyWhopWebhook(body, sign(body, "m", Math.floor(Date.now() / 1000) - 3600), SECRET)).toThrow();
  });
});

describe("helpers", () => {
  it("normalizes event names", () => {
    expect(eventType({ type: "payment.succeeded" })).toBe("payment.succeeded");
    expect(eventType({ action: "payment_succeeded" })).toBe("payment.succeeded");
    expect(eventType({ type: "dispute_alert_created" })).toBe("dispute_alert.created");
  });
  it("reads Whop money in major units", () => {
    expect(moneyToCents({ amount: "52.38", currency: "eur" })).toBe(5238);
    expect(moneyToCents(12.5)).toBe(1250);
    expect(moneyToCents(null)).toBeNull();
  });
});
