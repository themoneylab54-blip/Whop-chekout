import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "@/lib/crypto";

describe("encrypt / decrypt", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encrypt("shpat_secret");
    const b = encrypt("shpat_secret");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("shpat_secret");
  });
  it("rejects tampered ciphertext", () => {
    const parts = encrypt("secret").split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."))).toThrow();
  });
  it("rejects a different key", () => {
    const other = Buffer.alloc(32, 9).toString("base64");
    expect(() => decrypt(encrypt("secret"), other)).toThrow();
  });
});
