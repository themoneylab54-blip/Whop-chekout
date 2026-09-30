import { describe, expect, it } from "vitest";
import type { UserRole } from "@prisma/client";
import { accessibleStoreWhere, accessRefusal, canGrantRole, canManageMember, creatorAccessData, levelRole, roleAtLeast, roleCan, wouldRemoveLastOwner, type AccessLevel } from "@/lib/access";

/*
 * Team access (migration 0038_team_access): the role / level matrix, the store scope filter and
 * the last-owner guard, pure.
 */

const ROLES: UserRole[] = ["viewer", "admin", "owner"];
const LEVELS: AccessLevel[] = ["view", "edit", "owner"];

describe("roles and access levels", () => {
  it("roleAtLeast orders viewer < admin < owner", () => {
    const got = ROLES.map((r) => ROLES.map((min) => roleAtLeast(r, min)));
    expect(got).toEqual([
      [true, false, false],
      [true, true, false],
      [true, true, true],
    ]);
  });

  it("matrix: viewer = view; admin = view + edit; owner = everything", () => {
    const matrix = Object.fromEntries(ROLES.map((r) => [r, LEVELS.filter((l) => roleCan(r, l))]));
    expect(matrix).toEqual({ viewer: ["view"], admin: ["view", "edit"], owner: ["view", "edit", "owner"] });
    expect(LEVELS.map(levelRole)).toEqual(["viewer", "admin", "owner"]);
  });

  it("admins grant admin / viewer only; viewers grant nothing; owners anything", () => {
    expect(ROLES.map((r) => canGrantRole("owner", r))).toEqual([true, true, true]);
    expect(ROLES.map((r) => canGrantRole("admin", r))).toEqual([true, true, false]);
    expect(ROLES.map((r) => canGrantRole("viewer", r))).toEqual([false, false, false]);
  });

  it("admins never touch an owner; owners manage everyone", () => {
    expect(canManageMember({ role: "admin" }, { role: "owner" })).toBe(false);
    expect(canManageMember({ role: "admin" }, { role: "viewer" })).toBe(true);
    expect(canManageMember({ role: "admin" }, { role: "admin" })).toBe(true);
    expect(canManageMember({ role: "viewer" }, { role: "viewer" })).toBe(false);
    expect(canManageMember({ role: "owner" }, { role: "owner" })).toBe(true);
  });
});

describe("store scope", () => {
  it("allStores: no filter; limited: only the stores of its StoreAccess rows", () => {
    expect(accessibleStoreWhere({ id: "u1", allStores: true })).toEqual({});
    expect(accessibleStoreWhere({ id: "u1", allStores: false })).toEqual({ teamAccess: { some: { userId: "u1" } } });
  });

  it("a limited creator gets access to the store it creates", () => {
    expect(creatorAccessData({ id: "u1", allStores: true })).toEqual({});
    expect(creatorAccessData({ id: "u1", allStores: false })).toEqual({ teamAccess: { create: { userId: "u1" } } });
  });

  it("JSON refusals: 401 signed out, 404 out of scope, 403 role too low (owner-only says so)", () => {
    expect(accessRefusal("login", "view").status).toBe(401);
    expect(accessRefusal("notFound", "edit")).toMatchObject({ status: 404, body: { error: "store" } });
    expect(accessRefusal("forbidden", "edit").body.message).toMatch(/lecture seule/);
    expect(accessRefusal("forbidden", "owner").body.message).toMatch(/propriétaire/);
  });
});

describe("last-owner guard", () => {
  const team = [
    { id: "o1", role: "owner" as const },
    { id: "a1", role: "admin" as const },
    { id: "v1", role: "viewer" as const },
  ];

  it("the only owner can't be demoted or removed", () => {
    expect(wouldRemoveLastOwner(team, "o1", { role: "admin" })).toBe(true);
    expect(wouldRemoveLastOwner(team, "o1", { role: "viewer" })).toBe(true);
    expect(wouldRemoveLastOwner(team, "o1", { disable: true })).toBe(true);
  });

  it("other members, a same-role change or a second owner are fine", () => {
    expect(wouldRemoveLastOwner(team, "a1", { disable: true })).toBe(false);
    expect(wouldRemoveLastOwner(team, "a1", { role: "viewer" })).toBe(false);
    expect(wouldRemoveLastOwner(team, "o1", { role: "owner" })).toBe(false);
    const two = [...team, { id: "o2", role: "owner" as const }];
    expect(wouldRemoveLastOwner(two, "o1", { disable: true })).toBe(false);
    expect(wouldRemoveLastOwner(two, "o1", { role: "admin" })).toBe(false);
  });

  it("a disabled owner doesn't count", () => {
    const withGone = [...team, { id: "o2", role: "owner" as const, disabledAt: new Date() }];
    expect(wouldRemoveLastOwner(withGone, "o1", { disable: true })).toBe(true);
  });
});
