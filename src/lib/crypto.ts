import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

const ALGO = "aes-256-gcm";

/**
 * Derives the 32-byte AES key from ENCRYPTION_KEY. Accepts 32 bytes in base64
 * (`openssl rand -base64 32`) or hex (64 chars); any other secret of 16+ characters
 * (e.g. a generator's hex string or a passphrase) is hashed with SHA-256.
 */
export function deriveKey(raw: string): Buffer {
  const value = raw.trim();
  if (value.length < 16) {
    throw new Error("ENCRYPTION_KEY manquante ou trop courte (16 caractères minimum) : vérifiez les variables d'environnement.");
  }
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) return Buffer.from(value, "base64");
  return createHash("sha256").update(value, "utf8").digest();
}

function key(raw?: string): Buffer {
  return deriveKey(raw ?? env.encryptionKey);
}

/** Encrypts a secret for storage: `v1.<iv>.<tag>.<ciphertext>` (base64url parts). */
export function encrypt(plaintext: string, rawKey?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(rawKey), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv, tag, data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function decrypt(payload: string, rawKey?: string): string {
  const [version, iv, tag, data] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Malformed encrypted value");
  const decipher = createDecipheriv(ALGO, key(rawKey), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

export function decryptOrNull(payload: string | null | undefined): string | null {
  return payload ? decrypt(payload) : null;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
