import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clientIp } from "@/lib/ratelimit";
import { sameOrigin, strictSameOrigin } from "@/lib/stripe-state";
import { freshGoogleAuth, GOOGLE_REAUTH_MAX_AGE_MS, googleAuthorizeUrl, signGoogleState, verifyGoogleState } from "@/lib/google-auth";
import {
  ACCOUNT_FLASH,
  AUTH_ERRORS,
  authErrorMessage,
  DASHBOARD_FLASH,
  flashMessages,
  googleProvesEmail,
  loginUrl,
  PASSWORD_MAX_BYTES,
  PASSWORD_TOO_LONG_ERROR,
  passwordProblem,
  passwordProblemCode,
  isGmailAddress,
  safeNext,
  setupErrorMessage,
  SETUP_ERRORS,
  STORE_ACCESS_ERRORS,
  storeFlashMessage,
  TEAM_FLASH,
} from "@/lib/team-rules";
import { canGrantAccess, granterCanManage } from "@/lib/team";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Flash } from "@/components/ui";
import { ROLE_LABELS, TEAM_ONLY_ERROR } from "@/lib/access";

/*
 * Security rules of sign-in and the team (review of 0038), pure: client IP, strict same-origin,
 * safe `next`, password size, Google's proof of an address, error codes, re-authentication
 * freshness, who may grant what.
 */

describe("clientIp", () => {
  it("prefers the platform's headers over a client-supplied X-Forwarded-For", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 1.1.1.1", "x-vercel-forwarded-for": "2.2.2.2" }))).toBe("2.2.2.2");
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
    expect(clientIp(new Headers({ "x-forwarded-for": " 4.4.4.4 , 5.5.5.5" }))).toBe("4.4.4.4");
    expect(clientIp(new Headers())).toBe("unknown");
    expect(clientIp(new Request("https://x.test", { headers: { "x-real-ip": "7.7.7.7" } }))).toBe("7.7.7.7");
  });
});

describe("strictSameOrigin", () => {
  const app = "https://checkout.example.com";
  it("needs our Origin, or without it Sec-Fetch-Site: same-origin; nothing is refused", () => {
    expect(strictSameOrigin("https://checkout.example.com", null, app)).toBe(true);
    expect(strictSameOrigin("https://evil.example", "same-origin", app)).toBe(false);
    expect(strictSameOrigin(null, "same-origin", app)).toBe(true);
    expect(strictSameOrigin(null, "cross-site", app)).toBe(false);
    expect(strictSameOrigin(null, null, app)).toBe(false);
    // The lenient check other callers use is unchanged.
    expect(sameOrigin(null, app)).toBe(true);
  });
});

describe("safeNext", () => {
  it("only paths of this site", () => {
    expect(safeNext("/invite/abc")).toBe("/invite/abc");
    expect(safeNext("/dashboard?x=1")).toBe("/dashboard?x=1");
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "evil", "", null, undefined, "/a\\b", "/a\nb", `/${"a".repeat(600)}`]) expect(safeNext(bad)).toBeNull();
  });
});

describe("password size", () => {
  it("10 characters minimum, 72 UTF-8 bytes maximum (bcrypt ignores the rest)", () => {
    expect(passwordProblem("short")).toMatch(/10 caractères/);
    expect(passwordProblem("a".repeat(PASSWORD_MAX_BYTES))).toBeNull();
    expect(passwordProblem("a".repeat(PASSWORD_MAX_BYTES + 1))).toBe(PASSWORD_TOO_LONG_ERROR);
    // 37 « é » = 74 bytes.
    expect(passwordProblem("é".repeat(37))).toBe(PASSWORD_TOO_LONG_ERROR);
    expect(passwordProblem("é".repeat(36))).toBeNull();
  });
});

describe("Google proves an address", () => {
  it("Gmail addresses, or a Workspace account of the e-mail's domain (hd)", () => {
    expect(googleProvesEmail({ email: "jane@gmail.com" })).toBe(true);
    expect(googleProvesEmail({ email: "jane@googlemail.com" })).toBe(true);
    expect(googleProvesEmail({ email: "jane@acme.fr", hd: "acme.fr" })).toBe(true);
    expect(googleProvesEmail({ email: "jane@acme.fr", hd: "ACME.fr" })).toBe(true);
    expect(googleProvesEmail({ email: "jane@acme.fr" })).toBe(false);
    expect(googleProvesEmail({ email: "jane@acme.fr", hd: "other.fr" })).toBe(false);
    expect(googleProvesEmail({ email: "jane@acme.fr", hd: null })).toBe(false);
  });
});

describe("error codes", () => {
  it("a known code gives its fixed text; anything else nothing (no reflection)", () => {
    expect(authErrorMessage("not_authorized")).toBe(AUTH_ERRORS.not_authorized);
    expect(authErrorMessage("<script>alert(1)</script>")).toBeUndefined();
    expect(authErrorMessage("toString")).toBeUndefined();
    expect(authErrorMessage(undefined)).toBeUndefined();
    for (const text of Object.values(AUTH_ERRORS)) expect(text).not.toMatch(/@|GOOGLE_CLIENT/);
  });

  it("labels and refusals", () => {
    expect(ROLE_LABELS.viewer).toBe("Lecteur");
    expect(TEAM_ONLY_ERROR).toBe("Réservé aux admins et au propriétaire.");
    expect(DASHBOARD_FLASH.error.team_only).toBe(TEAM_ONLY_ERROR);
  });

  it("/dashboard, Profil and Équipe: `?ok=` / `?error=` are codes with fixed texts; anything else shows nothing", () => {
    for (const table of [DASHBOARD_FLASH, ACCOUNT_FLASH, TEAM_FLASH]) {
      for (const text of [...Object.values(table.ok), ...Object.values(table.error)]) expect(text).not.toMatch(/@|GOOGLE_CLIENT/);
      expect(flashMessages(table, { ok: "<b>pwned</b>", error: "Votre compte est bloqué, appelez le 06…" })).toEqual({ ok: undefined, error: undefined });
      expect(flashMessages(table, { ok: "toString", error: "__proto__" })).toEqual({ ok: undefined, error: undefined });
    }
    expect(flashMessages(DASHBOARD_FLASH, { ok: "self_viewer" }).ok).toMatch(/plus accès à l'Équipe/);
    expect(flashMessages(DASHBOARD_FLASH, { error: "read_only" }).error).toMatch(/lecture seule/);
    // Profil also shows the Google round trip's codes.
    expect(flashMessages(ACCOUNT_FLASH, { error: "google_taken" }).error).toBe(AUTH_ERRORS.google_taken);
    expect(ACCOUNT_FLASH.ok.reauth_ok).toBe("Identité confirmée : vous avez 5 minutes pour définir votre mot de passe.");
    expect(TEAM_FLASH.ok.email_authorized_google_off).toMatch(/dès que la connexion Google sera activée/);
  });

  it("password problems as codes (Profil) and texts (invitation, setup) agree", () => {
    expect(passwordProblemCode("short")).toBe("password_short");
    expect(passwordProblemCode("a".repeat(PASSWORD_MAX_BYTES + 1))).toBe("password_too_long");
    expect(passwordProblemCode("a-long-password")).toBeNull();
    expect(ACCOUNT_FLASH.error.password_short).toBe(passwordProblem("short"));
    expect(ACCOUNT_FLASH.error.password_too_long).toBe(PASSWORD_TOO_LONG_ERROR);
  });
});

describe("`next` through « Continuer avec Google »", () => {
  const now = 1_800_000_000_000;
  it("a safe path travels in the signed state; an unsafe one never does", () => {
    expect(verifyGoogleState(signGoogleState({ kind: "login", next: "/invite/abc" }, "n", now), "n", now)?.mode).toEqual({ kind: "login", next: "/invite/abc" });
    expect(verifyGoogleState(signGoogleState({ kind: "login", next: "//evil.example" }, "n", now), "n", now)?.mode).toEqual({ kind: "login" });
    expect(verifyGoogleState(signGoogleState({ kind: "login" }, "n", now), "n", now)?.mode).toEqual({ kind: "login" });
  });

  it("/login URLs keep a safe `next` next to the error code", () => {
    expect(loginUrl("rate", "/invite/abc")).toBe("/login?error=rate&next=%2Finvite%2Fabc");
    expect(loginUrl("rate", "//evil.example")).toBe("/login?error=rate");
    expect(loginUrl()).toBe("/login");
  });
});

describe("Google re-authentication", () => {
  const now = 1_800_000_000_000;
  it("fresh when Google asked for the password at most 5 minutes ago", () => {
    expect(freshGoogleAuth({ authTime: now / 1000 - 60 }, now)).toBe(true);
    expect(freshGoogleAuth({ authTime: (now - GOOGLE_REAUTH_MAX_AGE_MS - 1000) / 1000 }, now)).toBe(false);
    expect(freshGoogleAuth({ authTime: null }, now)).toBe(false);
    expect(freshGoogleAuth({}, now)).toBe(false);
    // From the future (clock skew beyond a minute): refused.
    expect(freshGoogleAuth({ authTime: now / 1000 + 600 }, now)).toBe(false);
  });

  it("the reauth mode round-trips; link / reauth ask Google for the password again (max_age=0)", () => {
    expect(verifyGoogleState(signGoogleState({ kind: "reauth", userId: "u1" }, "n", now), "n", now)?.mode).toEqual({ kind: "reauth", userId: "u1" });
    expect(new URL(googleAuthorizeUrl("s", "n", { fresh: true })).searchParams.get("max_age")).toBe("0");
    expect(new URL(googleAuthorizeUrl("s", "n")).searchParams.has("max_age")).toBe(false);
  });
});

describe("canGrantAccess", () => {
  it("role it may grant; all stores / owner only from someone who sees every store; else a subset of its stores", () => {
    const limitedAdmin = { role: "admin" as const, allStores: false, storeIds: ["a", "b"] };
    expect(canGrantAccess(limitedAdmin, { role: "viewer", allStores: false, storeIds: ["a"] })).toBe(true);
    expect(canGrantAccess(limitedAdmin, { role: "viewer", allStores: false, storeIds: ["a", "c"] })).toBe(false);
    expect(canGrantAccess(limitedAdmin, { role: "viewer", allStores: true, storeIds: [] })).toBe(false);
    expect(canGrantAccess(limitedAdmin, { role: "owner", allStores: true, storeIds: [] })).toBe(false);
    expect(canGrantAccess({ role: "admin", allStores: true, storeIds: [] }, { role: "admin", allStores: true, storeIds: [] })).toBe(true);
    expect(canGrantAccess({ role: "viewer", allStores: true, storeIds: [] }, { role: "viewer", allStores: false, storeIds: [] })).toBe(false);
    expect(canGrantAccess({ role: "owner", allStores: true, storeIds: [] }, { role: "owner", allStores: true, storeIds: [] })).toBe(true);
  });
});

describe("final round: fixed codes everywhere", () => {
  it("store pages: a refusal is a code with a fixed text; the overview shows only codes and its own fixed messages", () => {
    expect(storeFlashMessage("read_only")).toBe(STORE_ACCESS_ERRORS.read_only);
    expect(storeFlashMessage("owner_only")).toBe(STORE_ACCESS_ERRORS.owner_only);
    expect(storeFlashMessage("Votre compte est suspendu : appelez le 06…")).toBeUndefined();
    expect(storeFlashMessage("__proto__")).toBeUndefined();
    expect(storeFlashMessage("Checkout activé sur la boutique", ["Checkout activé sur la boutique"])).toBe("Checkout activé sur la boutique");
    expect(DASHBOARD_FLASH.error.read_only).toBe(STORE_ACCESS_ERRORS.read_only);
    expect(DASHBOARD_FLASH.error.create_store).toBe("Les lecteurs ne peuvent pas ajouter de boutique.");
    // The shared banner of the other store pages shows the code's text, not the code.
    const html = renderToStaticMarkup(createElement(Flash, { error: "owner_only" }));
    expect(html).toContain(STORE_ACCESS_ERRORS.owner_only);
    expect(html).not.toContain(">owner_only<");
  });

  it("/setup: codes with fixed texts; any other text shows nothing", () => {
    expect(setupErrorMessage("password_mismatch")).toBe(SETUP_ERRORS.password_mismatch);
    expect(setupErrorMessage("password_short")).toBe(passwordProblem("short"));
    expect(setupErrorMessage("Code d'installation incorrect")).toBeUndefined();
    expect(setupErrorMessage("constructor")).toBeUndefined();
    const actions = readFileSync(new URL("../src/app/setup/actions.ts", import.meta.url), "utf8");
    expect(actions).not.toContain("encodeURIComponent(error)");
  });

  it("new Équipe / Profil codes", () => {
    expect(TEAM_FLASH.ok.self_role_changed).toBe("Votre rôle a changé : vos autres appareils ont été déconnectés.");
    expect(TEAM_FLASH.ok.email_authorized_workspace).toMatch(/Google Workspace de ce domaine ; sinon, envoyez plutôt une invitation/);
    expect(TEAM_FLASH.error.invite_rate).toMatch(/Trop d'invitations/);
    expect(Object.keys(ACCOUNT_FLASH.ok)).not.toContain("signed_out_others_unlinked");
    expect(isGmailAddress("x@GMAIL.com")).toBe(true);
    expect(isGmailAddress("x@googlemail.com")).toBe(true);
    expect(isGmailAddress("x@example.com")).toBe(false);
  });

  it("the login page says what to do about a forgotten password", () => {
    const form = readFileSync(new URL("../src/app/login/LoginForm.tsx", import.meta.url), "utf8");
    expect(form).toContain("Mot de passe oublié ?");
    expect(form).toContain("Connectez-vous avec Google si votre compte est lié, sinon demandez au propriétaire de vous réinviter.");
  });

  it("granterCanManage: role it may manage, and every store the member sees within its own", () => {
    const limitedAdmin = { role: "admin" as const, allStores: false, storeIds: ["a", "b"] };
    expect(granterCanManage(limitedAdmin, { role: "viewer", allStores: false, storeIds: ["a"] })).toBe(true);
    expect(granterCanManage(limitedAdmin, { role: "viewer", allStores: false, storeIds: ["a", "c"] })).toBe(false);
    expect(granterCanManage(limitedAdmin, { role: "viewer", allStores: true, storeIds: [] })).toBe(false);
    expect(granterCanManage({ role: "admin", allStores: true, storeIds: [] }, { role: "owner", allStores: true, storeIds: [] })).toBe(false);
    expect(granterCanManage({ role: "owner", allStores: true, storeIds: [] }, { role: "owner", allStores: true, storeIds: [] })).toBe(true);
    expect(granterCanManage({ role: "viewer", allStores: true, storeIds: [] }, { role: "viewer", allStores: false, storeIds: [] })).toBe(false);
  });
});
