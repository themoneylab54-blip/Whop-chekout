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

describe("deriveKey", () => {
  it("accepts base64 (32 bytes), hex (64 chars) and any 16+ char secret", async () => {
    const { deriveKey } = await import("@/lib/crypto");
    const b64 = Buffer.alloc(32, 3).toString("base64");
    expect(deriveKey(b64)).toEqual(Buffer.alloc(32, 3));
    const hex64 = "ab".repeat(32);
    expect(deriveKey(hex64)).toEqual(Buffer.from(hex64, "hex"));
    expect(deriveKey("0123456789abcdef0123456789abcdef")).toHaveLength(32); // 32-char hex from a generator
    expect(deriveKey("une phrase secrète assez longue")).toHaveLength(32);
  });

  it("is stable and round-trips with non-base64 keys", async () => {
    const { deriveKey } = await import("@/lib/crypto");
    const k = "0123456789abcdef0123456789abcdef";
    expect(deriveKey(k)).toEqual(deriveKey(` ${k}\n`));
    expect(decrypt(encrypt("secret", k), k)).toBe("secret");
  });

  it("rejects missing or short keys with a clear message", async () => {
    const { deriveKey } = await import("@/lib/crypto");
    expect(() => deriveKey("")).toThrow(/ENCRYPTION_KEY/);
    expect(() => deriveKey("court")).toThrow(/ENCRYPTION_KEY/);
  });
});
