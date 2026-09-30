import "server-only";
import { redirect } from "next/navigation";
import type { Prisma, Store, UserRole } from "@prisma/client";
import { currentUser, type SessionUser } from "./auth";
import { db } from "./db";
import { flashUrl } from "./flash";
import { recordEvent } from "./log";
import { DASHBOARD_FLASH, type DashboardErrorCode, type StoreAccessErrorCode } from "./team-rules";

/**
 * Team access (migration 0038_team_access). Matrix:
 *   viewer = view;
 *   admin  = view + edit (+ invite admins / viewers);
 *   owner  = everything, incl. the team's owners and payment / platform connections
 *            (Whop, Stripe, Shopify connect / disconnect, API keys, deleting a store).
 * Store scope: `allStores`, else only the stores listed in StoreAccess.
 */
export type AccessLevel = "view" | "edit" | "owner";

export const ROLE_LABELS: Record<UserRole, string> = { owner: "Propriétaire", admin: "Admin", viewer: "Lecteur" };

const RANK: Record<UserRole, number> = { viewer: 0, admin: 1, owner: 2 };

/** `role` grants at least what `min` does. */
export function roleAtLeast(role: UserRole, min: UserRole): boolean {
  return RANK[role] >= RANK[min];
}

/** The lowest role an access level needs. */
export function levelRole(level: AccessLevel): UserRole {
  return level === "owner" ? "owner" : level === "edit" ? "admin" : "viewer";
}

/** `role` may act at `level` (on a store it can open). */
export function roleCan(role: UserRole, level: AccessLevel): boolean {
  return roleAtLeast(role, levelRole(level));
}

type ScopedUser = Pick<SessionUser, "id" | "allStores">;

/** Prisma filter of the stores `user` may open (spread into a `store.findMany` where). */
export function accessibleStoreWhere(user: ScopedUser): Prisma.StoreWhereInput {
  return user.allStores ? {} : { teamAccess: { some: { userId: user.id } } };
}

/** Spread into a new store's `data`: a creator limited to selected stores gets access to the one it creates. */
export function creatorAccessData(user: ScopedUser): { teamAccess?: { create: { userId: string } } } {
  return user.allStores ? {} : { teamAccess: { create: { userId: user.id } } };
}

/** `user` may open `storeId` (whatever its role). */
export async function canAccessStore(user: ScopedUser, storeId: string): Promise<boolean> {
  if (user.allStores) return true;
  const row = await db.storeAccess.findUnique({ where: { userId_storeId: { userId: user.id, storeId } }, select: { storeId: true } });
  return !!row;
}

export const READ_ONLY_ERROR = DASHBOARD_FLASH.error.read_only;
export const OWNER_ONLY_ERROR = DASHBOARD_FLASH.error.owner_only;
/** Équipe refused to a viewer. */
export const TEAM_ONLY_ERROR = DASHBOARD_FLASH.error.team_only;

export type StoreAccessResult =
  | { ok: true; user: SessionUser; store: Store }
  // login: not signed in (or session revoked); notFound: no such store, or not one of the user's; forbidden: role too low
  | { ok: false; reason: "login" | "notFound" | "forbidden"; user?: SessionUser };

/** Non-throwing check, for route handlers that answer JSON. */
export async function checkStoreAccess(storeId: string, level: AccessLevel): Promise<StoreAccessResult> {
  const user = await currentUser();
  if (!user) return { ok: false, reason: "login" };
  const store = await db.store.findUnique({ where: { id: storeId } });
  // A store outside the user's scope looks missing (its existence isn't disclosed).
  if (!store || !(await canAccessStore(user, storeId))) return { ok: false, reason: "notFound", user };
  if (!roleCan(user.role, level)) return { ok: false, reason: "forbidden", user };
  return { ok: true, user, store };
}

/** A failed check as a JSON answer (status + body), for route handlers called with fetch(). */
export function accessRefusal(reason: "login" | "notFound" | "forbidden", level: AccessLevel): { status: number; body: { error: string; message: string } } {
  if (reason === "login") return { status: 401, body: { error: "auth", message: "Session expirée, reconnectez-vous." } };
  if (reason === "notFound") return { status: 404, body: { error: "store", message: "Boutique introuvable." } };
  return { status: 403, body: { error: "forbidden", message: level === "owner" ? OWNER_ONLY_ERROR : READ_ONLY_ERROR } };
}

/**
 * For store-scoped pages, actions and routes: the user and the store, else a redirect — /login,
 * /dashboard (store missing or not the user's), or back to the store with the refusal as a flash.
 */
export async function requireStoreAccess(storeId: string, level: AccessLevel): Promise<{ user: SessionUser; store: Store }> {
  const res = await checkStoreAccess(storeId, level);
  if (res.ok) return { user: res.user, store: res.store };
  if (res.reason === "login") redirect("/login");
  if (res.reason === "notFound") redirect("/dashboard");
  // A code (fixed text on the page), never the text itself in the URL.
  redirect(flashUrl(`/dashboard/stores/${storeId}`, { error: storeRefusalCode(level) }));
}

/** The `?error=` code of a store refusal at `level` (see STORE_ACCESS_ERRORS). */
export function storeRefusalCode(level: AccessLevel): StoreAccessErrorCode {
  return level === "owner" ? "owner_only" : "read_only";
}

/**
 * For account-wide actions (create a store, team): the user when its role is at least `min`, else
 * back to /dashboard with the `refusal` code (default: owner-only / read-only; see DASHBOARD_FLASH).
 */
export async function requireRole(min: UserRole, refusal?: DashboardErrorCode): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!roleAtLeast(user.role, min)) redirect(flashUrl("/dashboard", { error: refusal ?? (min === "owner" ? "owner_only" : "read_only") }));
  return user;
}

/* ------------------------------------------------------------------ */
/* Team guards (pure)                                                  */
/* ------------------------------------------------------------------ */

/** `actor` may give `role` to someone (invite, authorized e-mail, role change): admins never grant owner. */
export function canGrantRole(actorRole: UserRole, role: UserRole): boolean {
  return actorRole === "owner" || (actorRole === "admin" && role !== "owner");
}

/** `actor` may change or remove `target`: owners manage everyone, admins only admins / viewers, viewers nobody. */
export function canManageMember(actor: { role: UserRole }, target: { role: UserRole }): boolean {
  return actor.role === "owner" || (actor.role === "admin" && target.role !== "owner");
}

export type TeamMember = { id: string; role: UserRole; disabledAt?: Date | null };

/**
 * Applying `change` to `targetId` (a new role, or its removal) would leave the team without an
 * active owner: such changes are refused.
 */
export function wouldRemoveLastOwner(members: readonly TeamMember[], targetId: string, change: { role?: UserRole; disable?: boolean }): boolean {
  const activeOwners = (list: readonly TeamMember[]) => list.filter((m) => !m.disabledAt && m.role === "owner").length;
  const after = members.map((m) =>
    m.id === targetId ? { ...m, role: change.role ?? m.role, disabledAt: change.disable ? (m.disabledAt ?? new Date()) : m.disabledAt } : m,
  );
  return activeOwners(members) > 0 && activeOwners(after) === 0;
}

/** Journal entry of a team change (`team.*`), account-wide unless `storeId`; `data.actorId` = who did it. */
export async function recordTeamEvent(e: { kind: string; message: string; actorId: string | null; storeId?: string | null; data?: Record<string, unknown> }) {
  await recordEvent({ storeId: e.storeId ?? null, kind: e.kind, message: e.message, data: { ...e.data, actorId: e.actorId } });
}
