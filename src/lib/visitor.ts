import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/*
 * Visitor ids for A/B arms (design tests, checkout tests) and unique-visitor counts. The arm is a
 * hash of the visitor id, so an id the browser chose would let a visitor pick the cheaper arm: the
 * id is issued by the server, signed (HMAC with SESSION_SECRET), and handed back on session
 * creation for the storefront loader to keep in its cookie. An unsigned, forged or missing id gets
 * a fresh server id. Sessions already stored keep the id they have.
 */

const RAW = /^[A-Za-z0-9]{16,40}$/;
const SIGNED = /^([A-Za-z0-9]{16,40})\.([\w-]{22})$/;

function signature(raw: string, secret: string): string {
  return createHmac("sha256", secret).update(`visitor\n${raw}`).digest("base64url").slice(0, 22);
}

/** "<id>.<signature>". Pure. */
export function signVisitorId(raw: string, secret = env.sessionSecret): string {
  if (!RAW.test(raw)) throw new Error("invalid visitor id");
  return `${raw}.${signature(raw, secret)}`;
}

/** The id inside a genuine signed token, else null. Pure. */
export function verifyVisitorId(token: string | null | undefined, secret = env.sessionSecret): string | null {
  const m = token ? SIGNED.exec(token) : null;
  if (!m) return null;
  const a = Buffer.from(signature(m[1], secret));
  const b = Buffer.from(m[2]);
  return a.length === b.length && timingSafeEqual(a, b) ? m[1] : null;
}

/** The visitor behind a token from the browser: its id when the signature holds, else a new server id. */
export function resolveVisitor(token: string | null | undefined, secret = env.sessionSecret): { id: string; token: string; issued: boolean } {
  const id = verifyVisitorId(token, secret);
  if (id) return { id, token: token!, issued: false };
  const fresh = randomBytes(12).toString("hex");
  return { id: fresh, token: signVisitorId(fresh, secret), issued: true };
}
