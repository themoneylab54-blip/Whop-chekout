import type { SessionUser } from "@/lib/auth";

/** A signed-in owner with every store, for tests that mock `@/lib/auth` (currentUser). */
export function ownerUser(id = "admin", over: Partial<SessionUser> = {}): SessionUser {
  return { id, email: `${id}@test.local`, name: null, avatarUrl: null, role: "owner", allStores: true, sessionVersion: 0, hasPassword: true, googleLinked: false, googleEmail: null, ...over };
}
