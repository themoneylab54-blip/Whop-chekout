/**
 * "Se souvenir de mes coordonnées" (returning-buyer autofill, privacy-first).
 *
 * Opt-in only. The buyer's contact and shipping details (never payment data) are kept in
 * `localStorage` of the checkout origin, so they come back on any store using this checkout
 * domain on the same device. Nothing here is ever sent to the server: the form is filled
 * locally and only the normal pay request carries the values. Every storage access is
 * guarded (private mode, blocked storage, quota).
 */

export const SAVED_BUYER_KEY = "wc:buyer:v1";
export const SAVED_BUYER_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export type SavedAddress = {
  firstName: string;
  lastName: string;
  address1: string;
  address2: string;
  city: string;
  province: string;
  zip: string;
  countryCode: string;
  phone: string;
};

export type SavedBuyer = { email: string; address: SavedAddress; savedAt: number; expiresAt: number };

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const ADDRESS_KEYS: (keyof SavedAddress)[] = ["firstName", "lastName", "address1", "address2", "city", "province", "zip", "countryCode", "phone"];
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** Parses a stored entry; null when malformed or expired. */
export function parseSavedBuyer(raw: string | null | undefined, now = Date.now()): SavedBuyer | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const email = str(v.email, 254).trim();
    const expiresAt = typeof v.expiresAt === "number" ? v.expiresAt : 0;
    if (!email || !email.includes("@") || !(expiresAt > now)) return null;
    const a = (v.address && typeof v.address === "object" ? v.address : {}) as Record<string, unknown>;
    const address = Object.fromEntries(ADDRESS_KEYS.map((k) => [k, str(a[k], 200)])) as SavedAddress;
    address.countryCode = address.countryCode.toUpperCase().slice(0, 2);
    return { email, address, savedAt: typeof v.savedAt === "number" ? v.savedAt : now, expiresAt };
  } catch {
    return null;
  }
}

/** JSON written to storage: contact + address only, with a 180-day expiry. */
export function serializeSavedBuyer(email: string, address: SavedAddress, now = Date.now()): string {
  const clean = Object.fromEntries(ADDRESS_KEYS.map((k) => [k, str(address[k], 200).trim()])) as SavedAddress;
  return JSON.stringify({ email: email.trim().slice(0, 254), address: clean, savedAt: now, expiresAt: now + SAVED_BUYER_TTL_MS });
}

/** "claire.martin@gmail.com" → "claire.martin@…" (enough to recognise oneself, not to read it out). */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? `${email.slice(0, at)}@…` : email;
}

function storage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();

export function subscribeSavedBuyer(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === SAVED_BUYER_KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

function notify() {
  for (const cb of listeners) cb();
}

/** Raw stored string (a stable snapshot for useSyncExternalStore); null when absent or unreadable. */
export function readSavedBuyerRaw(store: StorageLike | null = storage()): string | null {
  try {
    return store?.getItem(SAVED_BUYER_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeSavedBuyer(email: string, address: SavedAddress, store: StorageLike | null = storage()): boolean {
  try {
    if (!store) return false;
    store.setItem(SAVED_BUYER_KEY, serializeSavedBuyer(email, address));
    notify();
    return true;
  } catch {
    return false;
  }
}

export function clearSavedBuyer(store: StorageLike | null = storage()) {
  try {
    store?.removeItem(SAVED_BUYER_KEY);
  } catch {
    /* blocked storage: nothing was saved either */
  }
  notify();
}
