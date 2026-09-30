import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import {
  exchangeGoogleCode,
  googleAuthConfigured,
  googleAuthorizeUrl,
  GOOGLE_STATE_TTL_MS,
  signGoogleState,
  verifyGoogleIdToken,
  verifyGoogleState,
} from "@/lib/google-auth";
import { hashInviteToken, inviteStatus, newInviteToken } from "@/lib/team";

/*
 * « Continuer avec Google »: the signed state (modes, nonce cookie, expiry, tampering) and the ID token
 * checks against a locally generated key set served in place of Google's JWKS endpoint.
 */

describe("Google sign-in state", () => {
  const now = 1_800_000_000_000;

  it("round-trips each mode with the browser's nonce", () => {
    expect(verifyGoogleState(signGoogleState({ kind: "login" }, "n1", now), "n1", now)).toEqual({ mode: { kind: "login" }, nonce: "n1" });
    expect(verifyGoogleState(signGoogleState({ kind: "link", userId: "user_1" }, "n2", now), "n2", now)?.mode).toEqual({ kind: "link", userId: "user_1" });
    expect(verifyGoogleState(signGoogleState({ kind: "invite", inviteId: "inv_1" }, "n3", now), "n3", now)?.mode).toEqual({ kind: "invite", inviteId: "inv_1" });
  });

  it("refuses another browser's nonce, a missing cookie, and an expired state", () => {
    const state = signGoogleState({ kind: "login" }, "nonce", now);
    expect(verifyGoogleState(state, "other", now)).toBeNull();
    expect(verifyGoogleState(state, null, now)).toBeNull();
    expect(verifyGoogleState(state, "nonce", now + GOOGLE_STATE_TTL_MS - 1)).not.toBeNull();
    expect(verifyGoogleState(state, "nonce", now + GOOGLE_STATE_TTL_MS + 1)).toBeNull();
  });

  it("refuses a tampered payload or signature, and a state signed with another key", () => {
    const state = signGoogleState({ kind: "link", userId: "victim" }, "nonce", now);
    const [payload, sig] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), u: "attacker" })).toString("base64url");
    expect(verifyGoogleState(`${forged}.${sig}`, "nonce", now)).toBeNull();
    expect(verifyGoogleState(`${payload}.${sig.slice(0, -2)}xx`, "nonce", now)).toBeNull();
    expect(verifyGoogleState(`${state}.extra`, "nonce", now)).toBeNull();
    expect(verifyGoogleState(signGoogleState({ kind: "login" }, "nonce", now, "another-secret-of-32-characters!!"), "nonce", now)).toBeNull();
    expect(verifyGoogleState("", "nonce", now)).toBeNull();
  });

  it("the authorize URL asks for openid email profile with the account chooser, the state and the nonce", () => {
    const url = new URL(googleAuthorizeUrl("st", "nn"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("redirect_uri")).toBe("https://checkout.example.com/api/auth/google/callback");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("nonce")).toBe("nn");
  });

  it("is configured only with both the client id and secret", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    expect(googleAuthConfigured()).toBe(false);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    expect(googleAuthConfigured()).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("Google ID token", () => {
  const CLIENT = "client-123.apps.googleusercontent.com";
  let key: CryptoKey;
  let otherKey: CryptoKey;
  const certsHits: string[] = [];

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    key = pair.privateKey;
    otherKey = (await generateKeyPair("RS256")).privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    // Google's JWKS endpoint, served locally.
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      certsHits.push(url);
      if (url === "https://www.googleapis.com/oauth2/v3/certs") return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
      return new Response("not found", { status: 404 });
    });
  });
  afterAll(() => vi.unstubAllGlobals());

  const token = (claims: Record<string, unknown>, opts: { aud?: string; iss?: string; exp?: string; signWith?: CryptoKey } = {}) =>
    new SignJWT({ email: "Jane.Doe@Example.com", email_verified: true, name: "Jane Doe", picture: "https://lh3.googleusercontent.com/a/photo", nonce: "nn", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setSubject("google-sub-1")
      .setIssuer(opts.iss ?? "https://accounts.google.com")
      .setAudience(opts.aud ?? CLIENT)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "5m")
      .sign(opts.signWith ?? key);

  it("a valid token gives the identity, e-mail lowercased (keys fetched from Google's JWKS URL)", async () => {
    const id = await verifyGoogleIdToken(await token({}), { clientId: CLIENT, nonce: "nn" });
    expect(id).toEqual({ sub: "google-sub-1", email: "jane.doe@example.com", name: "Jane Doe", picture: "https://lh3.googleusercontent.com/a/photo", hd: null, authTime: null });
    expect(certsHits).toContain("https://www.googleapis.com/oauth2/v3/certs");
    // The issuer without scheme is Google's too.
    await expect(verifyGoogleIdToken(await token({}, { iss: "accounts.google.com" }), { clientId: CLIENT, nonce: "nn" })).resolves.toMatchObject({ sub: "google-sub-1" });
  });

  it("refuses an unverified e-mail", async () => {
    await expect(verifyGoogleIdToken(await token({ email_verified: false }), { clientId: CLIENT, nonce: "nn" })).rejects.toThrow(/not verified/);
    await expect(verifyGoogleIdToken(await token({ email_verified: undefined }), { clientId: CLIENT, nonce: "nn" })).rejects.toThrow(/not verified/);
  });

  it("refuses another audience, another issuer, an expired token, another key, another nonce", async () => {
    await expect(verifyGoogleIdToken(await token({}, { aud: "someone-else" }), { clientId: CLIENT, nonce: "nn" })).rejects.toThrow();
    await expect(verifyGoogleIdToken(await token({}, { iss: "https://evil.example.com" }), { clientId: CLIENT, nonce: "nn" })).rejects.toThrow();
    await expect(verifyGoogleIdToken(await token({}, { exp: "-1m" }), { clientId: CLIENT, nonce: "nn" })).rejects.toThrow();
    await expect(verifyGoogleIdToken(await token({}, { signWith: otherKey }), { clientId: CLIENT, nonce: "nn" })).rejects.toThrow();
    await expect(verifyGoogleIdToken(await token({ nonce: "other" }), { clientId: CLIENT, nonce: "nn" })).rejects.toThrow(/nonce/);
  });

  it("passes the Workspace domain (hd) and auth_time through; a malformed hd is dropped", async () => {
    const id = await verifyGoogleIdToken(await token({ hd: "Example.com", auth_time: 1_800_000_000 }), { clientId: CLIENT, nonce: "nn" });
    expect(id).toMatchObject({ hd: "example.com", authTime: 1_800_000_000 });
    expect((await verifyGoogleIdToken(await token({ hd: "bad domain!" }), { clientId: CLIENT, nonce: "nn" })).hd).toBeNull();
  });

  it("drops a non-https picture", async () => {
    const id = await verifyGoogleIdToken(await token({ picture: "javascript:alert(1)" }), { clientId: CLIENT, nonce: "nn" });
    expect(id.picture).toBeNull();
  });
});

describe("Google code exchange", () => {
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("posts the code with the client credentials and returns only the ID token; an error never carries the body's tokens", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "cid");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret");
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ access_token: "at-secret", id_token: "the-id-token" }), { status: 200 });
    });
    expect(await exchangeGoogleCode("code-1")).toBe("the-id-token");
    const body = new URLSearchParams(calls[0].body);
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(body)).toMatchObject({ code: "code-1", client_id: "cid", client_secret: "csecret", grant_type: "authorization_code", redirect_uri: "https://checkout.example.com/api/auth/google/callback" });

    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "invalid_grant", access_token: "leak" }), { status: 400 }));
    const err = await exchangeGoogleCode("code-2").catch((e: Error) => e);
    expect(String(err)).toContain("invalid_grant");
    expect(String(err)).not.toContain("leak");
  });
});

describe("invitation tokens", () => {
  it("32 random bytes, only the sha256 stored", () => {
    const { token, tokenHash } = newInviteToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(tokenHash).toBe(hashInviteToken(token));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(newInviteToken().token).not.toBe(token);
  });

  it("status: pending / expired / accepted / revoked; an authorized e-mail never expires", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    const later = new Date("2026-10-01T12:00:00Z");
    const base = { tokenHash: "h", expiresAt: later, acceptedAt: null, revokedAt: null };
    expect(inviteStatus(base, now)).toBe("pending");
    expect(inviteStatus({ ...base, expiresAt: new Date("2026-09-28T00:00:00Z") }, now)).toBe("expired");
    expect(inviteStatus({ ...base, acceptedAt: now }, now)).toBe("accepted");
    expect(inviteStatus({ ...base, revokedAt: now }, now)).toBe("revoked");
    expect(inviteStatus({ tokenHash: null, expiresAt: null, acceptedAt: null, revokedAt: null }, now)).toBe("pending");
  });
});
