import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_FLASH, DASHBOARD_FLASH, TEAM_FLASH } from "@/lib/team-rules";

/*
 * « Continuer avec Google », invitations, authorized e-mails, the Équipe and Profil actions, against
 * a real Postgres through the real session code (cookie jar faked). Google itself is mocked at the
 * module boundary (googleIdentityFromCode: code exchange + ID token verification, unit-tested in
 * tests/google-auth.test.ts). Test data is prefixed gteam_ and deleted at the end.
 */

const hasDb = !!process.env.DATABASE_URL;

class Redirect extends Error {
  digest: string;
  constructor(public url: string) {
    super("NEXT_REDIRECT");
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async (orig) => ({
  ...(await orig<typeof import("next/headers")>()),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidatePath: () => undefined }));

const google = vi.hoisted(() => ({ identity: vi.fn() }));
vi.mock("@/lib/google-auth", async (orig) => ({ ...(await orig<typeof import("@/lib/google-auth")>()), googleIdentityFromCode: google.identity }));
const mail = vi.hoisted(() => ({ mailer: vi.fn(async () => null as unknown), send: vi.fn(async () => true) }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), operatorMailer: mail.mailer, sendOperatorEmail: mail.send }));
// The per-IP limits have their own tests; here every test comes from the same "unknown" IP. A test
// may refuse some keys (limits.allow).
const limits = vi.hoisted(() => ({ allow: vi.fn(async (key: string) => !!key) }));
vi.mock("@/lib/ratelimit", async (orig) => ({ ...(await orig<typeof import("@/lib/ratelimit")>()), rateLimit: (key: string) => limits.allow(key) }));

/** The flash codes of the dashboard's own pages, each read back as the page shows it (its fixed text). */
const FLASH_TABLES: Record<string, { ok: Record<string, string>; error: Record<string, string> }> = {
  "/dashboard": DASHBOARD_FLASH,
  "/dashboard/account": ACCOUNT_FLASH,
  "/dashboard/team": TEAM_FLASH,
};

type Landing = { path: string; ok?: string; error?: string; okCode?: string; errorCode?: string; next?: string };

/**
 * Where a redirect lands. On /dashboard, Profil and Équipe the URL may only carry known codes (no
 * text, no e-mail): `ok` / `error` are the texts those pages show, `okCode` / `errorCode` the codes.
 * Elsewhere (/login, /invite) `error` is the code itself.
 */
function landing(url: URL): Landing {
  const okCode = url.searchParams.get("ok") ?? undefined;
  const errorCode = url.searchParams.get("error") ?? undefined;
  const next = url.searchParams.get("next") ?? undefined;
  const table = FLASH_TABLES[url.pathname];
  if (!table) return { path: url.pathname, ok: okCode, error: errorCode, next };
  if (okCode) expect(Object.keys(table.ok), `unknown ok code ${okCode}`).toContain(okCode);
  if (errorCode) expect(Object.keys(table.error), `unknown error code ${errorCode}`).toContain(errorCode);
  return { path: url.pathname, ok: okCode && table.ok[okCode], error: errorCode && table.error[errorCode], okCode, errorCode, next };
}

async function redirectOf(run: () => Promise<unknown>): Promise<Landing> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof Redirect)) throw err;
    return landing(new URL(err.url, "http://x"));
  }
  throw new Error("no redirect");
}

const form = (fields: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) fd.append(k, x);
  return fd;
};

describe.skipIf(!hasDb)("Google sign-in, invitations and team (integration)", async () => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
  const { db } = await import("@/lib/db");
  const auth = await import("@/lib/auth");
  const gauth = await import("@/lib/google-auth");
  const team = await import("@/lib/team");
  const callback = await import("@/app/api/auth/google/callback/route");
  const start = await import("@/app/api/auth/google/start/route");
  const teamActions = await import("@/app/dashboard/team/actions");
  const account = await import("@/app/dashboard/account/actions");
  const inviteActions = await import("@/app/invite/[token]/actions");
  const tag = `gteam_${Math.random().toString(36).slice(2, 8)}`;
  const stores: string[] = [];
  let n = 0;
  const email = (name: string) => `${tag}_${name}_${n++}@test.local`;
  const ctx = { params: Promise.resolve({}) };

  async function store() {
    const s = await db.store.create({ data: { name: `${tag}_store_${n++}` } });
    stores.push(s.id);
    return s;
  }
  async function user(role: "owner" | "admin" | "viewer", data: Record<string, unknown> = {}) {
    return db.adminUser.create({ data: { email: email(role), passwordHash: await auth.hashPassword("secret-password"), role, ...data } });
  }
  async function as(id: string) {
    jar.clear();
    expect(await auth.signIn(id)).toBe(true);
  }
  // Test addresses end in @test.local: by default a Workspace account of that domain (Google proves the address).
  const identity = (over: Partial<import("@/lib/google-auth").GoogleIdentity> = {}) => ({
    sub: `${tag}_sub_${n++}`,
    email: email("google"),
    name: "Jane Google",
    picture: "https://lh3.googleusercontent.com/a/x",
    hd: "test.local" as string | null,
    authTime: Math.floor(Date.now() / 1000) as number | null,
    ...over,
  });

  /** Google's redirect back to the callback, for a state issued to this browser (or `cookie`); `inviteToken`: the invitation cookie. */
  async function googleCallback(
    mode: import("@/lib/google-auth").GoogleMode,
    who: ReturnType<typeof identity> | Error,
    opts: { cookie?: string | null; query?: string; inviteToken?: string } = {},
  ) {
    const nonce = "nonce-1";
    const state = gauth.signGoogleState(mode, nonce);
    google.identity.mockReset();
    if (who instanceof Error) google.identity.mockRejectedValue(who);
    else google.identity.mockResolvedValue(who);
    const cookie = opts.cookie === undefined ? nonce : opts.cookie;
    const cookies = [cookie ? `wc_google_oauth=${cookie}` : null, opts.inviteToken ? `wc_google_invite=${opts.inviteToken}` : null].filter(Boolean).join("; ");
    const req = new Request(`https://checkout.example.com/api/auth/google/callback?${opts.query ?? `code=abc&state=${encodeURIComponent(state)}`}`, {
      headers: cookies ? { cookie: cookies } : {},
    });
    const res = await callback.GET(req, ctx);
    expect(res.status).toBe(307);
    // The nonce cookie is always cleared.
    expect(res.headers.get("set-cookie") ?? "").toMatch(/wc_google_oauth=;/);
    return landing(new URL(res.headers.get("location")!));
  }
  const signedIn = async () => (await auth.currentUser())?.id ?? null;

  /** The start route, as a form POST from our pages (Origin set unless `headers` says otherwise). */
  const startPost = (fields: Record<string, string>, headers: Record<string, string> = { origin: "https://checkout.example.com" }) =>
    start.POST(new Request("https://checkout.example.com/api/auth/google/start", { method: "POST", body: form(fields), headers }), ctx);

  // Invitations are sent by an active owner unless a test says otherwise (acceptance re-checks the inviter).
  const inviterOwner = await db.adminUser.create({ data: { email: email("inviter"), role: "owner" } });

  async function invite(data: { email: string; role?: "owner" | "admin" | "viewer"; allStores?: boolean; storeIds?: string[]; expiresAt?: Date; revokedAt?: Date; token?: boolean; invitedById?: string | null }) {
    const { token, tokenHash } = team.newInviteToken();
    const withToken = data.token !== false;
    const row = await db.teamInvite.create({
      data: {
        email: data.email,
        role: data.role ?? "admin",
        allStores: data.allStores ?? true,
        storeIds: data.storeIds ?? [],
        tokenHash: withToken ? tokenHash : null,
        expiresAt: withToken ? (data.expiresAt ?? new Date(Date.now() + team.INVITE_TTL_MS)) : null,
        revokedAt: data.revokedAt ?? null,
        invitedById: data.invitedById === undefined ? inviterOwner.id : data.invitedById,
      },
    });
    return { row, token };
  }

  beforeEach(() => {
    jar.clear();
    limits.allow.mockReset().mockImplementation(async () => true);
    mail.mailer.mockReset().mockResolvedValue(null);
    mail.send.mockReset().mockResolvedValue(true);
  });

  // All-stores members land on /dashboard only when they see more than one store: never depend
  // on what else the shared test database holds.
  beforeAll(async () => {
    await store();
    await store();
  });

  afterAll(async () => {
    await db.teamInvite.deleteMany({ where: { email: { startsWith: tag } } });
    await db.adminUser.deleteMany({ where: { email: { startsWith: tag } } });
    await db.store.deleteMany({ where: { id: { in: stores } } });
    vi.unstubAllEnvs();
  });

  /* ---------------------------------------------------------------- */

  describe("start", () => {
    it("a form POST from our origin → Google's account chooser, with the nonce cookie; another origin is refused", async () => {
      const res = await start.POST(new Request("https://checkout.example.com/api/auth/google/start", { method: "POST", body: form({ mode: "login" }), headers: { origin: "https://checkout.example.com" } }), ctx);
      expect(res.status).toBe(303);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.host).toBe("accounts.google.com");
      const nonce = /wc_google_oauth=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
      expect(nonce).toBeTruthy();
      expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
      expect(res.headers.get("set-cookie")).toMatch(/SameSite=lax/i);
      expect(gauth.verifyGoogleState(loc.searchParams.get("state")!, nonce)?.mode).toEqual({ kind: "login" });
      expect(loc.searchParams.get("nonce")).toBe(nonce);

      const foreign = await start.POST(new Request("https://checkout.example.com/api/auth/google/start", { method: "POST", body: form({ mode: "login" }), headers: { origin: "https://evil.example.org" } }), ctx);
      expect(foreign.status).toBe(403);
    });

    it("without Origin: only with Sec-Fetch-Site: same-origin (a cross-site form or a bare request is refused)", async () => {
      expect((await startPost({ mode: "login" }, {})).status).toBe(403);
      expect((await startPost({ mode: "login" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await startPost({ mode: "login" }, { "sec-fetch-site": "same-origin" })).status).toBe(303);
    });

    it("link needs a session and the current password, and binds the state to that member; an invitation needs a valid token", async () => {
      const u = await user("admin");
      const unsigned = await startPost({ mode: "link", currentPassword: "secret-password" });
      expect(new URL(unsigned.headers.get("location")!).pathname).toBe("/login");
      await as(u.id);
      const wrong = await startPost({ mode: "link", currentPassword: "wrong" });
      expect(new URL(wrong.headers.get("location")!).pathname).toBe("/dashboard/account");
      expect(landing(new URL(wrong.headers.get("location")!))).toMatchObject({ errorCode: "link_password", error: expect.stringMatching(/incorrect/) });
      expect(wrong.headers.get("set-cookie") ?? "").not.toMatch(/wc_google_oauth=[^;]/);
      const res = await startPost({ mode: "link", currentPassword: "secret-password" });
      const loc = new URL(res.headers.get("location")!);
      const nonce = /wc_google_oauth=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
      expect(gauth.verifyGoogleState(loc.searchParams.get("state")!, nonce)?.mode).toEqual({ kind: "link", userId: u.id });
      // Google must ask for its password again.
      expect(loc.searchParams.get("max_age")).toBe("0");

      jar.clear();
      const bad = await startPost({ mode: "invite", token: "nope" });
      expect(new URL(bad.headers.get("location")!).searchParams.get("error")).toBe("invite_invalid");
      const { row, token } = await invite({ email: email("inv") });
      const good = await startPost({ mode: "invite", token });
      const gl = new URL(good.headers.get("location")!);
      expect(gauth.verifyGoogleState(gl.searchParams.get("state")!, /wc_google_oauth=([^;]+)/.exec(good.headers.get("set-cookie") ?? "")?.[1])?.mode).toEqual({ kind: "invite", inviteId: row.id });
      // The token travels in an httpOnly cookie of this browser, never in the state sent to Google.
      expect(good.headers.get("set-cookie")).toContain(`wc_google_invite=${token}`);
      expect(gl.toString()).not.toContain(token);
    });

    it("link without a password (Google-only account) needs a fresh Google re-authentication, used once", async () => {
      const u = await db.adminUser.create({ data: { email: email("gonly-link"), role: "admin", googleSub: `${tag}_gl_${n++}` } });
      await as(u.id);
      const refused = await startPost({ mode: "link" });
      expect(landing(new URL(refused.headers.get("location")!))).toMatchObject({ errorCode: "link_reauth_first", error: expect.stringMatching(/Confirmez d'abord/) });
      await db.adminUser.update({ where: { id: u.id }, data: { reauthAt: new Date() } });
      const ok = await startPost({ mode: "link" });
      expect(new URL(ok.headers.get("location")!).host).toBe("accounts.google.com");
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).reauthAt).toBeNull();
    });

    it("`next` (a path of this site only) travels in the signed state; an unsafe one is dropped; signed in already: straight there", async () => {
      const stateOf = (res: Response) => {
        const loc = new URL(res.headers.get("location")!);
        return gauth.verifyGoogleState(loc.searchParams.get("state")!, /wc_google_oauth=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1]);
      };
      expect(stateOf(await startPost({ mode: "login", next: "/invite/abc" }))?.mode).toEqual({ kind: "login", next: "/invite/abc" });
      for (const bad of ["//evil.example/x", "https://evil.example", "/\\evil"]) expect(stateOf(await startPost({ mode: "login", next: bad }))?.mode).toEqual({ kind: "login" });
      // A refusal on the way keeps it for the next try.
      vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
      try {
        expect(landing(new URL((await startPost({ mode: "login", next: "/invite/abc" })).headers.get("location")!))).toMatchObject({ path: "/login", error: "google_off", next: "/invite/abc" });
      } finally {
        vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
      }
      const u = await user("admin");
      await as(u.id);
      expect(new URL((await startPost({ mode: "login", next: "/dashboard/account/confirm-email/tok" })).headers.get("location")!).pathname).toBe("/dashboard/account/confirm-email/tok");
    });

    it("hidden and refused while Google isn't configured", async () => {
      vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
      try {
        const res = await startPost({ mode: "login" });
        expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("google_off");
        expect(team.AUTH_ERRORS.google_off).not.toMatch(/GOOGLE_/);
      } finally {
        vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
      }
    });
  });

  describe("callback", () => {
    it("refuses a state without this browser's nonce cookie, or a forged one (nothing signed in)", async () => {
      expect(await googleCallback({ kind: "login" }, identity(), { cookie: null })).toMatchObject({ path: "/login", error: "state" });
      expect(await googleCallback({ kind: "login" }, identity(), { cookie: "other-nonce" })).toMatchObject({ path: "/login" });
      expect(await googleCallback({ kind: "login" }, identity(), { query: "code=abc&state=forged.state" })).toMatchObject({ path: "/login" });
      expect(google.identity).not.toHaveBeenCalled();
      expect(await signedIn()).toBeNull();
    });

    it("cancelled at Google, or an ID token refused (unverified e-mail…): back to /login", async () => {
      const state = gauth.signGoogleState({ kind: "login" }, "nonce-1");
      expect(await googleCallback({ kind: "login" }, identity(), { query: `error=access_denied&state=${encodeURIComponent(state)}` })).toMatchObject({ path: "/login", error: "cancelled" });
      expect(await googleCallback({ kind: "login" }, new Error("Google ID token: e-mail not verified"))).toMatchObject({ path: "/login", error: "google_failed" });
      expect(await signedIn()).toBeNull();
    });

    it("link: the signed-in member gets the Google account (its address kept, its photo when it had none); other devices are signed out", async () => {
      const u = await user("admin");
      await as(u.id);
      const otherDevice = jar.get("wc_session");
      await as(u.id);
      const id = identity({ email: email("other-address") });
      const res = await googleCallback({ kind: "link", userId: u.id }, id);
      expect(res).toMatchObject({ path: "/dashboard/account", ok: expect.stringMatching(/lié/) });
      // No e-mail in the URL.
      expect(res.ok).not.toContain("@");
      const after = await db.adminUser.findUniqueOrThrow({ where: { id: u.id } });
      expect(after).toMatchObject({ googleSub: id.sub, googleEmail: id.email, avatarUrl: id.picture, name: "Jane Google", email: u.email });
      expect(await auth.sessionUser(await auth.readSession(otherDevice))).toBeNull();
      expect(await auth.currentUser()).toMatchObject({ id: u.id, googleLinked: true, googleEmail: id.email });
      // Then « Continuer avec Google » signs that member in.
      jar.clear();
      expect(await googleCallback({ kind: "login" }, id)).toMatchObject({ path: "/dashboard" });
      expect(await signedIn()).toBe(u.id);
    });

    it("link: replacing a linked Google account leaves the profile alone (filled only at the first link)", async () => {
      const u = await user("admin", { googleSub: `${tag}_first_${n++}`, googleEmail: "first@gmail.com" });
      await as(u.id);
      const res = await googleCallback({ kind: "link", userId: u.id }, identity());
      expect(res).toMatchObject({ path: "/dashboard/account", okCode: "google_linked" });
      expect(await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({ name: null, avatarUrl: null });
    });

    it("link: refused when that Google account is another member's, or when the session changed", async () => {
      const a = await user("admin");
      const b = await user("admin", { googleSub: `${tag}_taken_${n++}` });
      await as(a.id);
      expect(await googleCallback({ kind: "link", userId: a.id }, identity({ sub: b.googleSub! }))).toMatchObject({ path: "/dashboard/account", error: team.GOOGLE_TAKEN_ERROR });
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: a.id } })).googleSub).toBeNull();
      // A state issued to b, completed in a browser signed in as a: refused.
      expect(await googleCallback({ kind: "link", userId: b.id }, identity())).toMatchObject({ path: "/login", error: "session" });
    });

    it("`next` from the state: the member lands there once signed in; a refusal goes back to /login with it", async () => {
      const u = await user("viewer", { googleSub: `${tag}_next_${n++}` });
      expect(await googleCallback({ kind: "login", next: "/invite/some-token" }, identity({ sub: u.googleSub! }))).toMatchObject({ path: "/invite/some-token" });
      expect(await signedIn()).toBe(u.id);
      jar.clear();
      expect(await googleCallback({ kind: "login", next: "/dashboard/account/confirm-email/t" }, identity())).toMatchObject({ path: "/login", error: "not_authorized", next: "/dashboard/account/confirm-email/t" });
    });

    it("login by googleSub signs in without touching the profile (a removed photo, a changed name stay as the member set them)", async () => {
      const u = await user("viewer", { googleSub: `${tag}_known_${n++}`, name: "Mon nom" });
      expect(await googleCallback({ kind: "login" }, identity({ sub: u.googleSub!, email: email("whatever") }))).toMatchObject({ path: "/dashboard" });
      expect(await signedIn()).toBe(u.id);
      const after = await db.adminUser.findUniqueOrThrow({ where: { id: u.id } });
      expect(after.name).toBe("Mon nom");
      expect(after.avatarUrl).toBeNull();
      expect(after.lastLoginAt).toBeInstanceOf(Date);
      expect(await db.eventLog.count({ where: { kind: "team.login", data: { path: ["actorId"], equals: u.id } } })).toBe(1);
    });

    it("login by proven e-mail without a Google account yet: linked (other sessions end); one with another Google account: refused", async () => {
      const u = await user("admin");
      await as(u.id);
      const before = jar.get("wc_session");
      jar.clear();
      const id = identity({ email: u.email });
      expect(await googleCallback({ kind: "login" }, id)).toMatchObject({ path: "/dashboard" });
      expect(await signedIn()).toBe(u.id);
      expect(await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({ googleSub: id.sub, googleEmail: u.email });
      expect(await auth.sessionUser(await auth.readSession(before))).toBeNull();
      jar.clear();
      expect(await googleCallback({ kind: "login" }, identity({ email: u.email }))).toMatchObject({ path: "/login", error: "other_google" });
      expect(await signedIn()).toBeNull();
    });

    it("auto-link by e-mail only when Google proves the address (Gmail, or hd = the e-mail's domain)", async () => {
      const u = await user("admin");
      // A consumer Google account created with a non-Gmail address: not proof enough.
      expect(await googleCallback({ kind: "login" }, identity({ email: u.email, hd: null }))).toMatchObject({ path: "/login", error: "unproven_email" });
      expect(await googleCallback({ kind: "login" }, identity({ email: u.email, hd: "other.example" }))).toMatchObject({ path: "/login", error: "unproven_email" });
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).googleSub).toBeNull();
      expect(await signedIn()).toBeNull();
      // A Gmail address is Google's own.
      const g = await user("admin", { email: `${tag}_gmail_${n++}@gmail.com` });
      expect(await googleCallback({ kind: "login" }, identity({ email: g.email, hd: null }))).toMatchObject({ path: "/dashboard" });
      expect(await signedIn()).toBe(g.id);
    });

    it("an authorized e-mail (no link) needs a proven address; the invitation link doesn't", async () => {
      const s = await store();
      const a = identity({ hd: null });
      await invite({ email: a.email, token: false, role: "viewer", allStores: false, storeIds: [s.id] });
      expect(await googleCallback({ kind: "login" }, a)).toMatchObject({ path: "/login", error: "unproven_join" });
      // Same for a pending invitation found by address only (the link wasn't used).
      const b = identity({ hd: null });
      const { row, token } = await invite({ email: b.email });
      expect(await googleCallback({ kind: "login" }, b)).toMatchObject({ error: "unproven_join" });
      expect(await db.adminUser.count({ where: { email: { in: [a.email, b.email] } } })).toBe(0);
      // Through its link: fine.
      expect((await googleCallback({ kind: "invite", inviteId: row.id }, b, { inviteToken: token })).path).toBe("/dashboard");
      expect(await db.adminUser.count({ where: { email: b.email } })).toBe(1);
    });

    it("an unknown e-mail is refused; nothing is created", async () => {
      const id = identity();
      expect(await googleCallback({ kind: "login" }, id)).toMatchObject({ path: "/login", error: "not_authorized" });
      expect(await db.adminUser.count({ where: { email: id.email } })).toBe(0);
    });

    it("a pending invitation: the member is created with its role and stores, the invitation used up", async () => {
      const s1 = await store();
      const s2 = await store();
      const id = identity();
      const { row } = await invite({ email: id.email, role: "viewer", allStores: false, storeIds: [s1.id, "gone-store"] });
      const res = await googleCallback({ kind: "login" }, id);
      // Its only store: straight there.
      expect(res.path).toBe(`/dashboard/stores/${s1.id}`);
      const created = await db.adminUser.findUniqueOrThrow({ where: { email: id.email }, include: { storeAccess: true } });
      expect(created).toMatchObject({ role: "viewer", allStores: false, googleSub: id.sub, name: "Jane Google", passwordHash: null });
      expect(created.storeAccess.map((a) => a.storeId)).toEqual([s1.id]);
      expect(await signedIn()).toBe(created.id);
      expect((await db.teamInvite.findUniqueOrThrow({ where: { id: row.id } })).acceptedAt).toBeInstanceOf(Date);
      void s2;
    });

    it("an expired or revoked invitation doesn't let anyone in", async () => {
      const a = identity();
      await invite({ email: a.email, expiresAt: new Date(Date.now() - 1000) });
      expect(await googleCallback({ kind: "login" }, a)).toMatchObject({ path: "/login", error: "not_authorized" });
      const b = identity();
      await invite({ email: b.email, revokedAt: new Date() });
      expect(await googleCallback({ kind: "login" }, b)).toMatchObject({ path: "/login", error: "not_authorized" });
      expect(await db.adminUser.count({ where: { email: { in: [a.email, b.email] } } })).toBe(0);
    });

    it("an authorized e-mail: created with StoreAccess on the stores that still exist; the entry stays usable", async () => {
      const s = await store();
      const id = identity();
      const { row } = await invite({ email: id.email, token: false, role: "admin", allStores: false, storeIds: [s.id, "deleted-store"] });
      await googleCallback({ kind: "login" }, id);
      const created = await db.adminUser.findUniqueOrThrow({ where: { email: id.email }, include: { storeAccess: true } });
      expect(created).toMatchObject({ role: "admin", allStores: false });
      expect(created.storeAccess.map((a) => a.storeId)).toEqual([s.id]);
      // Reusable, but it records who joined through it.
      expect(await db.teamInvite.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ acceptedAt: null, usedById: created.id });
      expect(await db.eventLog.count({ where: { kind: "team.member_joined", data: { path: ["actorId"], equals: created.id } } })).toBe(1);
    });

    it("from an invitation link: the Google e-mail must be the invited one; a failure goes back to the invitation's page (code only)", async () => {
      const { row, token } = await invite({ email: email("invited") });
      const other = identity();
      const res = await googleCallback({ kind: "invite", inviteId: row.id }, other, { inviteToken: token });
      expect(res).toMatchObject({ path: `/invite/${token}`, error: "invite_mismatch" });
      expect(await db.adminUser.count({ where: { email: other.email } })).toBe(0);
      // Without this invitation's cookie (another link's token, or none): /login.
      expect(await googleCallback({ kind: "invite", inviteId: row.id }, other, { inviteToken: "someone-elses" })).toMatchObject({ path: "/login", error: "invite_mismatch" });
      const invited = identity({ email: row.email });
      expect((await googleCallback({ kind: "invite", inviteId: row.id }, invited, { inviteToken: token })).path).toBe("/dashboard");
      expect(await db.adminUser.count({ where: { email: row.email, googleSub: invited.sub } })).toBe(1);
      expect((await db.teamInvite.findUniqueOrThrow({ where: { id: row.id } })).usedById).not.toBeNull();
      // Used up: the same link again is refused.
      jar.clear();
      expect(await googleCallback({ kind: "invite", inviteId: row.id }, invited, { inviteToken: token })).toMatchObject({ path: `/invite/${token}`, error: "invite_invalid" });
    });

    it("an invitation whose inviter can no longer grant it (removed, demoted, narrowed, or unknown) is refused", async () => {
      const s = await store();
      const admin = await user("admin");
      const a = identity();
      const viaAdmin = await invite({ email: a.email, role: "admin", invitedById: admin.id });
      // Demoted behind the team page's back (the page revokes such invitations itself).
      await db.adminUser.update({ where: { id: admin.id }, data: { role: "viewer" } });
      expect(await googleCallback({ kind: "invite", inviteId: viaAdmin.row.id }, a, { inviteToken: viaAdmin.token })).toMatchObject({ error: "inviter_gone" });
      // Rolled back: the invitation is still pending for a new decision.
      expect((await db.teamInvite.findUniqueOrThrow({ where: { id: viaAdmin.row.id } })).acceptedAt).toBeNull();

      const limited = await user("admin", { allStores: false });
      const b = identity();
      const viaLimited = await invite({ email: b.email, role: "viewer", allStores: false, storeIds: [s.id], invitedById: limited.id });
      expect(await googleCallback({ kind: "invite", inviteId: viaLimited.row.id }, b, { inviteToken: viaLimited.token })).toMatchObject({ error: "inviter_gone" });

      const c = identity();
      const orphan = await invite({ email: c.email, invitedById: null });
      expect(await googleCallback({ kind: "invite", inviteId: orphan.row.id }, c, { inviteToken: orphan.token })).toMatchObject({ error: "inviter_gone" });
      expect(await db.adminUser.count({ where: { email: { in: [a.email, b.email, c.email] } } })).toBe(0);
    });

    it("a removed member is refused, even by Google account or authorized e-mail; a new invitation brings it back", async () => {
      const u = await user("admin", { googleSub: `${tag}_removed_${n++}`, disabledAt: new Date() });
      const id = identity({ sub: u.googleSub!, email: u.email });
      expect(await googleCallback({ kind: "login" }, id)).toMatchObject({ path: "/login", error: "removed" });
      const s = await store();
      await invite({ email: u.email, role: "viewer", allStores: false, storeIds: [s.id] });
      expect((await googleCallback({ kind: "login" }, id)).path).toBe(`/dashboard/stores/${s.id}`);
      const back = await db.adminUser.findUniqueOrThrow({ where: { id: u.id }, include: { storeAccess: true } });
      // Back with the way in used now only: its former password doesn't come back.
      expect(back).toMatchObject({ disabledAt: null, role: "viewer", allStores: false, googleSub: id.sub, passwordHash: null });
      expect(back.storeAccess.map((a) => a.storeId)).toEqual([s.id]);
    });

    it("the same invitation used twice at once: one member, one acceptance", async () => {
      const inv = email("race");
      const { row } = await invite({ email: inv });
      const results = await Promise.all([
        team.joinFromInvite(row, { email: inv, googleSub: `${tag}_race_a` }),
        team.joinFromInvite(row, { email: inv, googleSub: `${tag}_race_b` }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await db.adminUser.count({ where: { email: inv } })).toBe(1);
    });

    it("an invitation link used as proof to link Google to an existing member is used up (and adds its access) in the same step", async () => {
      const s = await store();
      const m = await user("viewer", { allStores: false });
      // A non-Gmail consumer account: Google doesn't prove the address — only the link does.
      const id = identity({ email: m.email, hd: null });
      const { row, token } = await invite({ email: m.email, role: "admin", allStores: false, storeIds: [s.id] });
      expect((await googleCallback({ kind: "invite", inviteId: row.id }, id, { inviteToken: token })).path).toMatch(/^\/dashboard/);
      expect(await signedIn()).toBe(m.id);
      const after = await db.adminUser.findUniqueOrThrow({ where: { id: m.id }, include: { storeAccess: true } });
      expect(after).toMatchObject({ googleSub: id.sub, role: "admin", allStores: false });
      expect(after.storeAccess.map((a) => a.storeId)).toEqual([s.id]);
      expect(await db.teamInvite.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ acceptedAt: expect.any(Date), usedById: m.id });
      // The same link can't prove anything a second time.
      jar.clear();
      const again = identity({ email: m.email, hd: null });
      expect(await googleCallback({ kind: "invite", inviteId: row.id }, again, { inviteToken: token })).toMatchObject({ error: "invite_invalid" });
    });

    it("a link that can't be used (inviter gone) links nothing: Google account and invitation left as they were", async () => {
      const m = await user("viewer");
      const gone = await user("admin", { disabledAt: new Date() });
      const id = identity({ email: m.email, hd: null });
      const { row, token } = await invite({ email: m.email, role: "admin", invitedById: gone.id });
      expect(await googleCallback({ kind: "invite", inviteId: row.id }, id, { inviteToken: token })).toMatchObject({ error: "inviter_gone" });
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: m.id } })).googleSub).toBeNull();
      expect((await db.teamInvite.findUniqueOrThrow({ where: { id: row.id } })).acceptedAt).toBeNull();
    });

    it("an invitation or authorized e-mail whose stores were all deleted opens nothing: refused", async () => {
      const s = await store();
      const a = identity();
      const { row, token } = await invite({ email: a.email, role: "viewer", allStores: false, storeIds: [s.id] });
      const b = identity();
      await invite({ email: b.email, role: "viewer", allStores: false, storeIds: [s.id], token: false });
      await db.store.delete({ where: { id: s.id } });
      expect(await googleCallback({ kind: "invite", inviteId: row.id }, a, { inviteToken: token })).toMatchObject({ error: "invite_invalid" });
      expect(await googleCallback({ kind: "login" }, b)).toMatchObject({ error: "invite_invalid" });
      expect(await inviteActions.acceptInviteWithPasswordAction({}, form({ token, name: "A", password: "a-long-password", confirm: "a-long-password" }))).toMatchObject({ error: team.INVITE_INVALID_ERROR });
      expect(await db.adminUser.count({ where: { email: { in: [a.email, b.email] } } })).toBe(0);
      expect((await db.teamInvite.findUniqueOrThrow({ where: { id: row.id } })).acceptedAt).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- */

  describe("invitation page: accept with a password", () => {
    it("creates the member, signs it in; the link is single use", async () => {
      const inviter = await user("owner");
      const { row, token } = await invite({ email: email("pw"), role: "admin", invitedById: inviter.id });
      const res = await redirectOf(() => inviteActions.acceptInviteWithPasswordAction({}, form({ token, name: " Paul  Martin ", password: "a-long-password", confirm: "a-long-password" })));
      expect(res.path).toMatch(/^\/dashboard/);
      const created = await db.adminUser.findUniqueOrThrow({ where: { email: row.email } });
      expect(created).toMatchObject({ name: "Paul Martin", role: "admin", googleSub: null });
      expect(await signedIn()).toBe(created.id);
      expect(await auth.login(row.email, "a-long-password")).toBe(true);
      jar.clear();
      expect(await inviteActions.acceptInviteWithPasswordAction({}, form({ token, name: "X", password: "another-password", confirm: "another-password" }))).toMatchObject({ error: team.INVITE_INVALID_ERROR });
      expect(await auth.login(row.email, "another-password")).toBe(false);
    });

    it("refuses an expired or revoked link, a short password, a mismatch", async () => {
      const expired = await invite({ email: email("exp"), expiresAt: new Date(Date.now() - 1) });
      const revoked = await invite({ email: email("rev"), revokedAt: new Date() });
      const ok = { name: "A", password: "a-long-password", confirm: "a-long-password" };
      expect(await inviteActions.acceptInviteWithPasswordAction({}, form({ token: expired.token, ...ok }))).toMatchObject({ error: team.INVITE_INVALID_ERROR });
      expect(await inviteActions.acceptInviteWithPasswordAction({}, form({ token: revoked.token, ...ok }))).toMatchObject({ error: team.INVITE_INVALID_ERROR });
      const fresh = await invite({ email: email("fresh") });
      expect(await inviteActions.acceptInviteWithPasswordAction({}, form({ token: fresh.token, name: "A", password: "short", confirm: "short" }))).toMatchObject({ error: expect.stringMatching(/10 caractères/) });
      // Over 72 bytes (bcrypt would silently ignore the rest).
      const long = "é".repeat(40);
      expect(await inviteActions.acceptInviteWithPasswordAction({}, form({ token: fresh.token, name: "A", password: long, confirm: long }))).toMatchObject({ error: team.PASSWORD_TOO_LONG_ERROR });
      expect(await inviteActions.acceptInviteWithPasswordAction({}, form({ token: fresh.token, name: "A", password: "a-long-password", confirm: "a-different-one" }))).toMatchObject({ error: expect.stringMatching(/correspondent/) });
      expect(await db.adminUser.count({ where: { email: { in: [expired.row.email, revoked.row.email, fresh.row.email] } } })).toBe(0);
    });

    it("an active member with that e-mail can't create a second account; signed in as it, « Accepter » adds the access", async () => {
      const s = await store();
      const member = await user("viewer", { allStores: false });
      const { row, token } = await invite({ email: member.email, role: "admin", allStores: false, storeIds: [s.id] });
      expect(await inviteActions.acceptInviteWithPasswordAction({}, form({ token, name: "A", password: "a-long-password", confirm: "a-long-password" }))).toMatchObject({ error: team.ALREADY_MEMBER_ERROR });
      expect((await db.teamInvite.findUniqueOrThrow({ where: { id: row.id } })).acceptedAt).toBeNull();
      await as(member.id);
      await redirectOf(() => inviteActions.acceptInviteAsMemberAction(form({ token })));
      const after = await db.adminUser.findUniqueOrThrow({ where: { id: member.id }, include: { storeAccess: true } });
      expect(after).toMatchObject({ role: "admin", allStores: false });
      expect(after.storeAccess.map((a) => a.storeId)).toEqual([s.id]);
      // Another member can't accept someone else's invitation (a code, no e-mail in the URL).
      const other = await invite({ email: email("someone") });
      expect(await redirectOf(() => inviteActions.acceptInviteAsMemberAction(form({ token: other.token })))).toMatchObject({ path: `/invite/${other.token}`, error: "wrong_account" });
    });

    it("« Accepter » as a member is refused when the inviter can no longer grant it (the invitation stays pending)", async () => {
      const member = await user("viewer");
      const inviter = await user("admin");
      const { row, token } = await invite({ email: member.email, role: "admin", invitedById: inviter.id });
      await db.adminUser.update({ where: { id: inviter.id }, data: { disabledAt: new Date() } });
      await as(member.id);
      expect(await redirectOf(() => inviteActions.acceptInviteAsMemberAction(form({ token })))).toMatchObject({ error: "inviter_gone" });
      expect(await db.adminUser.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({ role: "viewer" });
      expect((await db.teamInvite.findUniqueOrThrow({ where: { id: row.id } })).acceptedAt).toBeNull();
    });

    it("no escalation by stacking invitations: a limited admin's « Admin on X » can't make an all-stores reader an admin everywhere", async () => {
      const x = await store();
      const owner = await user("owner");
      const limitedAdmin = await user("admin", { allStores: false, storeAccess: { create: { storeId: x.id } } });
      const bob = email("bob");
      const fromA = await invite({ email: bob, role: "admin", allStores: false, storeIds: [x.id], invitedById: limitedAdmin.id });
      const fromOwner = await invite({ email: bob, role: "viewer", allStores: true, invitedById: owner.id });
      // Bob joins through the owner's link…
      const joined = await redirectOf(() => inviteActions.acceptInviteWithPasswordAction({}, form({ token: fromOwner.token, name: "Bob", password: "a-long-password", confirm: "a-long-password" })));
      expect(joined.path).toMatch(/^\/dashboard/);
      const bobRow = await db.adminUser.findUniqueOrThrow({ where: { email: bob } });
      expect(bobRow).toMatchObject({ role: "viewer", allStores: true });
      // …the address's other links died with that join; A's link can't be used any more.
      expect((await db.teamInvite.findUniqueOrThrow({ where: { id: fromA.row.id } })).revokedAt).toBeInstanceOf(Date);
      expect(await redirectOf(() => inviteActions.acceptInviteAsMemberAction(form({ token: fromA.token })))).toMatchObject({ path: `/invite/${fromA.token}`, error: "invite_invalid" });
      expect(await db.adminUser.findUniqueOrThrow({ where: { id: bobRow.id } })).toMatchObject({ role: "viewer", allStores: true });

      // And an A invitation made afterwards (behind the team page's back) is checked on what bob would end up with.
      const late = await invite({ email: bob, role: "admin", allStores: false, storeIds: [x.id], invitedById: limitedAdmin.id });
      expect(await redirectOf(() => inviteActions.acceptInviteAsMemberAction(form({ token: late.token })))).toMatchObject({ error: "invite_exceeds" });
      expect(await db.adminUser.findUniqueOrThrow({ where: { id: bobRow.id } })).toMatchObject({ role: "viewer", allStores: true });
      expect((await db.teamInvite.findUniqueOrThrow({ where: { id: late.row.id } })).acceptedAt).toBeNull();

      // Within A's reach it works: a reader limited to X becomes admin on X.
      const carol = await user("viewer", { allStores: false, storeAccess: { create: { storeId: x.id } } });
      const ok = await invite({ email: carol.email, role: "admin", allStores: false, storeIds: [x.id], invitedById: limitedAdmin.id });
      await as(carol.id);
      await redirectOf(() => inviteActions.acceptInviteAsMemberAction(form({ token: ok.token })));
      expect(await db.adminUser.findUniqueOrThrow({ where: { id: carol.id } })).toMatchObject({ role: "admin", allStores: false });
    });

    it("signed in with another address: « Me déconnecter » comes back to the invitation", async () => {
      const u = await user("admin");
      await as(u.id);
      const { token } = await invite({ email: email("elsewhere") });
      expect(await redirectOf(() => inviteActions.signOutForInviteAction(form({ token })))).toMatchObject({ path: `/invite/${token}` });
      expect(await signedIn()).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- */

  describe("Équipe actions", () => {
    it("a viewer can't open the team actions", async () => {
      const v = await user("viewer");
      await as(v.id);
      expect(await redirectOf(() => teamActions.createInviteAction({}, form({ email: email("x"), role: "viewer", allStores: "on" })))).toMatchObject({ path: "/dashboard", error: expect.any(String) });
    });

    it("invite: the link is returned once (only its hash stored), e-mailed when a mailer is configured; an active member is refused", async () => {
      const o = await user("owner");
      await as(o.id);
      mail.mailer.mockResolvedValue({ apiKey: "k", from: "noreply@example.com", source: "env" });
      const target = email("newbie");
      const res = await teamActions.createInviteAction({}, form({ email: target.toUpperCase(), role: "admin", allStores: "on" }));
      expect(res.link).toMatch(/^https:\/\/checkout\.example\.com\/invite\//);
      expect(res.ok).toMatch(/envoyée/);
      const token = res.link!.split("/invite/")[1];
      const row = await db.teamInvite.findFirstOrThrow({ where: { email: target } });
      expect(row).toMatchObject({ tokenHash: team.hashInviteToken(token), role: "admin", allStores: true, invitedById: o.id });
      expect(JSON.stringify(row)).not.toContain(token);
      expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: target, html: expect.stringContaining(res.link!) }));
      expect(await teamActions.createInviteAction({}, form({ email: o.email, role: "viewer", allStores: "on" }))).toMatchObject({ error: expect.stringMatching(/déjà partie/) });
      // Without a mailer: the link to copy.
      mail.mailer.mockResolvedValue(null);
      expect(await teamActions.createInviteAction({}, form({ email: email("copy"), role: "viewer", allStores: "on" }))).toMatchObject({ warning: expect.stringMatching(/copiez le lien/), link: expect.any(String) });
    });

    it("resend: a new link, the old one stops working; revoke: the link is dead", async () => {
      const o = await user("owner");
      await as(o.id);
      const { row, token } = await invite({ email: email("resend") });
      const res = await teamActions.resendInviteAction({}, form({ inviteId: row.id }));
      const fresh = res.link!.split("/invite/")[1];
      expect(fresh).not.toBe(token);
      expect(await team.findInviteByToken(token)).toBeNull();
      expect((await team.findInviteByToken(fresh))?.status).toBe("pending");
      await redirectOf(() => teamActions.revokeInviteAction(form({ inviteId: row.id })));
      expect((await team.findInviteByToken(fresh))?.status).toBe("revoked");
    });

    it("an admin can't grant owner, nor touch an owner", async () => {
      const a = await user("admin");
      const o = await user("owner");
      const v = await user("viewer");
      await as(a.id);
      expect(await teamActions.createInviteAction({}, form({ email: email("x"), role: "owner" }))).toMatchObject({ error: expect.stringMatching(/propriétaire/) });
      expect(await redirectOf(() => teamActions.updateMemberRoleAction(form({ memberId: v.id, role: "owner" })))).toMatchObject({ error: expect.stringMatching(/propriétaire/) });
      expect(await redirectOf(() => teamActions.updateMemberRoleAction(form({ memberId: o.id, role: "viewer" })))).toMatchObject({ error: expect.stringMatching(/propriétaire/) });
      expect(await redirectOf(() => teamActions.removeMemberAction(form({ memberId: o.id })))).toMatchObject({ error: expect.stringMatching(/propriétaire/) });
      expect(await redirectOf(() => teamActions.addAuthorizedEmailAction(form({ email: email("x"), role: "owner" })))).toMatchObject({ error: expect.stringMatching(/propriétaire/) });
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: o.id } })).role).toBe("owner");
      // Admin → viewer on an admin is fine, and signs that member out.
      await as(v.id);
      const stale = jar.get("wc_session");
      await as(a.id);
      expect(await redirectOf(() => teamActions.updateMemberRoleAction(form({ memberId: v.id, role: "admin" })))).toMatchObject({ ok: expect.any(String) });
      expect(await auth.sessionUser(await auth.readSession(stale))).toBeNull();
    });

    it("a limited admin only grants its own stores, never « toutes les boutiques »", async () => {
      const mine = await store();
      const other = await store();
      const a = await user("admin", { allStores: false, storeAccess: { create: { storeId: mine.id } } });
      await as(a.id);
      expect(await teamActions.createInviteAction({}, form({ email: email("x"), role: "viewer", allStores: "on" }))).toMatchObject({ error: expect.stringMatching(/auxquelles vous avez accès/) });
      expect(await teamActions.createInviteAction({}, form({ email: email("x"), role: "viewer", storeIds: [other.id] }))).toMatchObject({ error: expect.stringMatching(/auxquelles vous avez accès/) });
      expect(await teamActions.createInviteAction({}, form({ email: email("x"), role: "viewer", storeIds: [mine.id] }))).toMatchObject({ link: expect.any(String) });
      // A new invitation only replaces the previous ones it could have sent itself.
      const target = email("contested");
      const ownersInvite = await invite({ email: target, role: "admin", allStores: true });
      const mineInvite = await invite({ email: target, role: "viewer", allStores: false, storeIds: [mine.id], invitedById: a.id });
      expect(await teamActions.createInviteAction({}, form({ email: target, role: "viewer", storeIds: [mine.id] }))).toMatchObject({ link: expect.any(String) });
      expect((await db.teamInvite.findUniqueOrThrow({ where: { id: ownersInvite.row.id } })).revokedAt).toBeNull();
      expect((await db.teamInvite.findUniqueOrThrow({ where: { id: mineInvite.row.id } })).revokedAt).toBeInstanceOf(Date);
      // Changing a limited member's stores keeps the ones the admin can't see.
      const v = await user("viewer", { allStores: false, storeAccess: { create: [{ storeId: other.id }] } });
      await redirectOf(() => teamActions.updateMemberAccessAction(form({ memberId: v.id, storeIds: [mine.id] })));
      expect((await db.storeAccess.findMany({ where: { userId: v.id } })).map((r) => r.storeId).sort()).toEqual([mine.id, other.id].sort());
      // A member with every store can't be narrowed by it.
      const wide = await user("viewer");
      expect(await redirectOf(() => teamActions.updateMemberAccessAction(form({ memberId: wide.id, storeIds: [mine.id] })))).toMatchObject({ error: expect.any(String) });
    });

    it("a limited admin can't change the role of, nor remove, a member who sees stores outside its own", async () => {
      const mine = await store();
      const other = await store();
      const a = await user("admin", { allStores: false, storeAccess: { create: { storeId: mine.id } } });
      const wider = await user("viewer", { allStores: false, storeAccess: { create: [{ storeId: mine.id }, { storeId: other.id }] } });
      const everywhere = await user("viewer");
      const inside = await user("viewer", { allStores: false, storeAccess: { create: { storeId: mine.id } } });
      await as(a.id);
      for (const target of [wider, everywhere]) {
        expect(await redirectOf(() => teamActions.updateMemberRoleAction(form({ memberId: target.id, role: "admin" })))).toMatchObject({ error: expect.stringMatching(/boutiques que vous ne voyez pas/) });
        expect(await redirectOf(() => teamActions.removeMemberAction(form({ memberId: target.id })))).toMatchObject({ error: expect.stringMatching(/boutiques que vous ne voyez pas/) });
      }
      for (const t of [wider, everywhere]) expect(await db.adminUser.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ role: "viewer", disabledAt: null });
      // Within its stores: fine.
      expect(await redirectOf(() => teamActions.updateMemberRoleAction(form({ memberId: inside.id, role: "admin" })))).toMatchObject({ ok: expect.any(String) });
    });

    it("removal detaches the password and Google account and revokes every entry tied to the member (its address, the ones it used, the ones it sent)", async () => {
      const o = await user("owner");
      const m = await user("admin", { googleSub: `${tag}_rm_${n++}`, googleEmail: "rm@gmail.com" });
      // It joined through an authorized e-mail, then changed its address.
      const used = await invite({ email: email("old-address"), token: false });
      await db.teamInvite.update({ where: { id: used.row.id }, data: { usedById: m.id } });
      const sent = await invite({ email: email("sent-by-m"), role: "viewer", invitedById: m.id });
      const sentAuthorized = await invite({ email: email("allowed-by-m"), role: "viewer", token: false, invitedById: m.id });
      const unrelated = await invite({ email: email("unrelated") });
      await as(o.id);
      expect(await redirectOf(() => teamActions.removeMemberAction(form({ memberId: m.id })))).toMatchObject({ ok: expect.any(String) });
      expect(await db.adminUser.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ passwordHash: null, googleSub: null, googleEmail: null });
      const rows = await db.teamInvite.findMany({ where: { id: { in: [used.row.id, sent.row.id, sentAuthorized.row.id, unrelated.row.id] } } });
      const revoked = Object.fromEntries(rows.map((r) => [r.id, !!r.revokedAt]));
      expect(revoked).toEqual({ [used.row.id]: true, [sent.row.id]: true, [sentAuthorized.row.id]: true, [unrelated.row.id]: false });
    });

    it("demotion revokes the pending invitations the member can no longer grant", async () => {
      const o = await user("owner");
      const owner2 = await user("owner");
      const admin = await user("admin");
      const ownerInvite = await invite({ email: email("by-owner2"), role: "owner", invitedById: owner2.id });
      const adminInvite = await invite({ email: email("by-owner2-admin"), role: "admin", invitedById: owner2.id });
      const byAdmin = await invite({ email: email("by-admin"), role: "viewer", token: false, invitedById: admin.id });
      await as(o.id);
      await redirectOf(() => teamActions.updateMemberRoleAction(form({ memberId: owner2.id, role: "admin" })));
      await redirectOf(() => teamActions.updateMemberRoleAction(form({ memberId: admin.id, role: "viewer" })));
      const state = async (id: string) => !!(await db.teamInvite.findUniqueOrThrow({ where: { id } })).revokedAt;
      expect(await state(ownerInvite.row.id)).toBe(true);
      expect(await state(adminInvite.row.id)).toBe(false);
      expect(await state(byAdmin.row.id)).toBe(true);
    });

    it("demoting itself to Lecteur: back to /dashboard with a message; a viewer is refused Équipe with its own message", async () => {
      const o = await user("owner");
      const a = await user("admin");
      await as(a.id);
      expect(await redirectOf(() => teamActions.updateMemberRoleAction(form({ memberId: a.id, role: "viewer" })))).toMatchObject({ path: "/dashboard", ok: expect.stringMatching(/plus accès à l'Équipe/) });
      expect(await auth.currentUser()).toMatchObject({ id: a.id, role: "viewer" });
      expect(await redirectOf(() => teamActions.revokeInviteAction(form({ inviteId: "x" })))).toMatchObject({ path: "/dashboard", error: "Réservé aux admins et au propriétaire." });
      void o;
    });

    it("the last owner can't be demoted nor removed; with a second owner it can; removal signs out and closes the way back", async () => {
      // Only this test's owners count as active owners.
      const others = await db.adminUser.findMany({ where: { role: "owner", disabledAt: null }, select: { id: true } });
      await db.adminUser.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { disabledAt: new Date() } });
      try {
        const o = await user("owner");
        await as(o.id);
        expect(await redirectOf(() => teamActions.updateMemberRoleAction(form({ memberId: o.id, role: "admin" })))).toMatchObject({ error: expect.stringMatching(/au moins un propriétaire/) });
        expect(await redirectOf(() => teamActions.removeMemberAction(form({ memberId: o.id })))).toMatchObject({ error: expect.stringMatching(/dernier propriétaire/) });
        expect((await db.adminUser.findUniqueOrThrow({ where: { id: o.id } })).role).toBe("owner");

        const o2 = await user("owner");
        await as(o2.id);
        const stale = jar.get("wc_session");
        await as(o.id);
        await invite({ email: o2.email, token: false });
        expect(await redirectOf(() => teamActions.removeMemberAction(form({ memberId: o2.id })))).toMatchObject({ ok: expect.stringMatching(/retiré/) });
        const removed = await db.adminUser.findUniqueOrThrow({ where: { id: o2.id } });
        expect(removed.disabledAt).toBeInstanceOf(Date);
        expect(await auth.sessionUser(await auth.readSession(stale))).toBeNull();
        expect(await auth.login(o2.email, "secret-password")).toBe(false);
        // Its authorized e-mail went with it.
        expect(await db.teamInvite.count({ where: { email: o2.email, revokedAt: null } })).toBe(0);
        // Demoting itself is fine once another owner exists.
        const o3 = await user("owner");
        expect(await redirectOf(() => teamActions.updateMemberRoleAction(form({ memberId: o.id, role: "admin" })))).toMatchObject({
          path: "/dashboard/team",
          okCode: "self_role_changed",
          ok: "Votre rôle a changé : vos autres appareils ont été déconnectés.",
        });
        // …and this device stays signed in (with the new role).
        expect(await auth.currentUser()).toMatchObject({ id: o.id, role: "admin" });
        void o3;
      } finally {
        await db.adminUser.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { disabledAt: null } });
      }
    });

    it("authorized e-mails: added once, refused for an active member, removed", async () => {
      const o = await user("owner");
      await as(o.id);
      const target = email("allowed");
      expect(await redirectOf(() => teamActions.addAuthorizedEmailAction(form({ email: target, role: "viewer", allStores: "on" })))).toMatchObject({ ok: expect.any(String) });
      expect(await redirectOf(() => teamActions.addAuthorizedEmailAction(form({ email: target, role: "viewer", allStores: "on" })))).toMatchObject({ error: expect.stringMatching(/déjà dans/) });
      expect(await redirectOf(() => teamActions.addAuthorizedEmailAction(form({ email: o.email, role: "viewer", allStores: "on" })))).toMatchObject({ error: expect.stringMatching(/déjà partie/) });
      const entry = await db.teamInvite.findFirstOrThrow({ where: { email: target } });
      expect(entry).toMatchObject({ tokenHash: null, expiresAt: null, role: "viewer" });
      await redirectOf(() => teamActions.removeAuthorizedEmailAction(form({ inviteId: entry.id })));
      expect(await googleCallback({ kind: "login" }, identity({ email: target }))).toMatchObject({ error: "not_authorized" });
    });

    it("authorizing an e-mail while Google sign-in is off says it will work once Google is on", async () => {
      const o = await user("owner");
      await as(o.id);
      vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
      try {
        expect(await redirectOf(() => teamActions.addAuthorizedEmailAction(form({ email: `${tag}_later_${n++}@gmail.com`, role: "viewer", allStores: "on" })))).toMatchObject({
          okCode: "email_authorized_google_off",
          ok: expect.stringMatching(/dès que la connexion Google sera activée/),
        });
      } finally {
        vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
      }
      expect(await redirectOf(() => teamActions.addAuthorizedEmailAction(form({ email: `${tag}_now_${n++}@googlemail.com`, role: "viewer", allStores: "on" })))).toMatchObject({ okCode: "email_authorized" });
    });

    it("authorizing an address Google doesn't prove on its own (not Gmail): works only as a Workspace account — says so", async () => {
      const o = await user("owner");
      await as(o.id);
      expect(await redirectOf(() => teamActions.addAuthorizedEmailAction(form({ email: email("corp"), role: "viewer", allStores: "on" })))).toMatchObject({
        okCode: "email_authorized_workspace",
        ok: "E-mail autorisé : il fonctionnera seulement si c'est une adresse Google Workspace de ce domaine ; sinon, envoyez plutôt une invitation.",
      });
    });

    it("« Changer » with the same role: nothing changes, nobody is signed out, « Rôle inchangé »", async () => {
      const o = await user("owner");
      const v = await user("viewer");
      await as(v.id);
      const vCookie = jar.get("wc_session");
      await as(o.id);
      expect(await redirectOf(() => teamActions.updateMemberRoleAction(form({ memberId: v.id, role: "viewer" })))).toMatchObject({ okCode: "role_unchanged", ok: "Rôle inchangé." });
      expect(await auth.sessionUser(await auth.readSession(vCookie))).toMatchObject({ id: v.id });
    });

    it("an admin limited to stores that no longer exist has nothing to share: invitations and authorized e-mails refused", async () => {
      const a = await user("admin", { allStores: false });
      await as(a.id);
      expect(await teamActions.createInviteAction({}, form({ email: email("x"), role: "viewer" }))).toMatchObject({ error: TEAM_FLASH.error.no_store_to_share });
      expect(await redirectOf(() => teamActions.addAuthorizedEmailAction(form({ email: email("x"), role: "viewer" })))).toMatchObject({ errorCode: "no_store_to_share" });
      expect(await db.teamInvite.count({ where: { invitedById: a.id } })).toBe(0);
    });

    it("stores of a member: read and written in one transaction (a member removed meanwhile is refused, nothing written)", async () => {
      const o = await user("owner");
      const s = await store();
      const gone = await user("viewer", { disabledAt: new Date() });
      await as(o.id);
      expect(await redirectOf(() => teamActions.updateMemberAccessAction(form({ memberId: gone.id, storeIds: [s.id] })))).toMatchObject({ errorCode: "member_not_found" });
      expect(await db.storeAccess.count({ where: { userId: gone.id } })).toBe(0);
      const v = await user("viewer");
      expect(await redirectOf(() => teamActions.updateMemberAccessAction(form({ memberId: v.id, storeIds: [s.id] })))).toMatchObject({ okCode: "access_changed" });
      expect(await db.adminUser.findUniqueOrThrow({ where: { id: v.id }, include: { storeAccess: true } })).toMatchObject({ allStores: false, storeAccess: [expect.objectContaining({ storeId: s.id })] });
      // Concurrent changes: every attempt either applies whole or is refused as a conflict — never a mix.
      const results = await Promise.all(
        [[s.id], []].map((ids) => redirectOf(() => teamActions.updateMemberAccessAction(form(ids.length ? { memberId: v.id, storeIds: ids } : { memberId: v.id, allStores: "on" })))),
      );
      for (const r of results) expect(["access_changed", undefined]).toContain(r.okCode);
      const final = await db.adminUser.findUniqueOrThrow({ where: { id: v.id }, include: { storeAccess: true } });
      expect(final.allStores ? final.storeAccess.length === 0 : final.storeAccess.length === 1).toBe(true);
    });

    it("row buttons name the member / address they act on (screen readers)", async () => {
      const { renderToStaticMarkup } = await import("react-dom/server");
      const { createElement } = await import("react");
      const { RoleChangeForm, ResendInvite } = await import("@/app/dashboard/team/TeamForms");
      const html = renderToStaticMarkup(
        createElement("div", null, [
          createElement(RoleChangeForm, { key: "r", memberId: "m1", email: "zoe@example.com", role: "viewer", roles: [{ value: "admin", label: "Admin" }, { value: "viewer", label: "Lecteur" }], title: "t", description: "d" }),
          createElement(ResendInvite, { key: "i", inviteId: "i1", email: "max@example.com" }),
        ]),
      );
      expect(html).toContain('aria-label="Changer le rôle de zoe@example.com"');
      expect(html).toContain('aria-label="Renvoyer l&#x27;invitation de max@example.com"');
      // « Changer » stays disabled until another role is picked.
      expect(/<button[^>]*aria-label="Changer le rôle de zoe@example.com"[^>]*>/.exec(html)![0]).toContain("disabled");
      const page = (await import("node:fs")).readFileSync(new URL("../../src/app/dashboard/team/page.tsx", import.meta.url), "utf8");
      expect(page).toContain("aria-label={`Révoquer l'invitation de ${i.email}`}");
      expect(page).toContain("aria-label={`Retirer ${a.email} des e-mails autorisés`}");
      expect(page).toContain("aria-label={`Retirer ${m.email}`}");
    });
  });

  /* ---------------------------------------------------------------- */

  describe("Profil actions", () => {
    it("a Google-only account: its first password needs a fresh Google re-authentication (its own account, used once); then it may unlink Google", async () => {
      const sub = `${tag}_gonly_${n++}`;
      const u = await db.adminUser.create({ data: { email: email("gonly"), role: "admin", googleSub: sub, googleEmail: "gonly@gmail.com" } });
      await as(u.id);
      expect(await redirectOf(() => account.unlinkGoogleAction())).toMatchObject({ error: expect.stringMatching(/mot de passe/) });
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).googleSub).not.toBeNull();
      // No re-authentication yet: refused.
      expect(await redirectOf(() => account.setPasswordAction(form({ password: "a-long-password", confirm: "a-long-password" })))).toMatchObject({ error: expect.stringMatching(/Confirmez d'abord/) });
      // Re-authentication with another Google account, or one Google didn't just ask the password of: refused.
      expect(await googleCallback({ kind: "reauth", userId: u.id }, identity({ sub: `${tag}_someone_${n++}` }))).toMatchObject({ path: "/dashboard/account", error: expect.stringMatching(/compte Google lié/) });
      expect(await googleCallback({ kind: "reauth", userId: u.id }, identity({ sub, authTime: Math.floor(Date.now() / 1000) - 3600 }))).toMatchObject({ error: expect.stringMatching(/redemandé/) });
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).reauthAt).toBeNull();
      const confirmed = await googleCallback({ kind: "reauth", userId: u.id }, identity({ sub }));
      expect(confirmed).toMatchObject({ path: "/dashboard/account", okCode: "reauth_ok", ok: "Identité confirmée : vous avez 5 minutes pour définir votre mot de passe." });
      expect(await redirectOf(() => account.setPasswordAction(form({ password: "short", confirm: "short" })))).toMatchObject({ error: expect.stringMatching(/10/) });
      expect(await redirectOf(() => account.setPasswordAction(form({ password: "a-long-password", confirm: "a-long-password" })))).toMatchObject({ ok: expect.any(String) });
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).reauthAt).toBeNull();
      const before = jar.get("wc_session");
      await as(u.id);
      // Unlinking needs the current password, typed again.
      expect(await redirectOf(() => account.unlinkGoogleAction(form({ currentPassword: "wrong-password" })))).toMatchObject({ errorCode: "current_password" });
      expect(await redirectOf(() => account.unlinkGoogleAction(form({})))).toMatchObject({ errorCode: "current_password" });
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).googleSub).toBe(sub);
      expect(await redirectOf(() => account.unlinkGoogleAction(form({ currentPassword: "a-long-password" })))).toMatchObject({ ok: expect.stringMatching(/délié/) });
      expect(await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({ googleSub: null, googleEmail: null });
      // Unlinking signs the other devices out; this one stays.
      expect(await auth.sessionUser(await auth.readSession(before))).toBeNull();
      expect(await signedIn()).toBe(u.id);
      expect(await auth.login(u.email, "a-long-password")).toBe(true);
    });

    it("the re-authentication is used once: a second password can't be set with it", async () => {
      const sub = `${tag}_once_${n++}`;
      const u = await db.adminUser.create({ data: { email: email("once"), role: "admin", googleSub: sub, reauthAt: new Date(Date.now() - 6 * 60_000) } });
      await as(u.id);
      // Older than 5 minutes: refused.
      expect(await redirectOf(() => account.setPasswordAction(form({ password: "a-long-password", confirm: "a-long-password" })))).toMatchObject({ error: expect.stringMatching(/Confirmez d'abord/) });
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).passwordHash).toBeNull();
    });

    it("changing the password needs the current one, is capped at 72 bytes, and may unlink Google at the same time", async () => {
      const u = await user("admin", { googleSub: `${tag}_pw_${n++}`, googleEmail: "pw@gmail.com" });
      await as(u.id);
      expect(await redirectOf(() => account.setPasswordAction(form({ currentPassword: "wrong", password: "a-new-password!", confirm: "a-new-password!" })))).toMatchObject({ error: expect.stringMatching(/incorrect/) });
      const long = "a".repeat(73);
      expect(await redirectOf(() => account.setPasswordAction(form({ currentPassword: "secret-password", password: long, confirm: long })))).toMatchObject({ error: team.PASSWORD_TOO_LONG_ERROR });
      expect(await redirectOf(() => account.setPasswordAction(form({ currentPassword: "secret-password", password: "a-new-password!", confirm: "a-new-password!", unlinkGoogle: "on" })))).toMatchObject({ ok: expect.stringMatching(/délié/) });
      expect(await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({ googleSub: null, googleEmail: null });
      expect(await auth.login(u.email, "a-new-password!")).toBe(true);
    });

    it("« Déconnecter mes autres appareils »: older cookies die, this device stays signed in; the Google account stays linked", async () => {
      const u = await user("admin", { googleSub: `${tag}_so_${n++}` });
      await as(u.id);
      const old = jar.get("wc_session");
      expect(await redirectOf(() => account.signOutEverywhereAction())).toMatchObject({ okCode: "signed_out_others" });
      expect(await auth.sessionUser(await auth.readSession(old))).toBeNull();
      expect(await signedIn()).toBe(u.id);
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).googleSub).not.toBeNull();
    });

    it("name; e-mail change (no e-mail sender) with the current password, unique and lowercased; an address with a pending entry is refused", async () => {
      const u = await user("admin");
      const taken = await user("viewer");
      await as(u.id);
      await redirectOf(() => account.updateProfileAction(form({ name: "  Léa   Durand " })));
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).name).toBe("Léa Durand");
      expect(await redirectOf(() => account.changeEmailAction(form({ email: email("new"), currentPassword: "wrong" })))).toMatchObject({ error: expect.stringMatching(/incorrect/) });
      expect(await redirectOf(() => account.changeEmailAction(form({ email: taken.email, currentPassword: "secret-password" })))).toMatchObject({ error: expect.stringMatching(/déjà utilisé/) });
      // Taking over an address someone was invited / authorized with: refused without a confirmation e-mail.
      const invited = email("invited-owner");
      await invite({ email: invited, role: "owner", token: false });
      expect(await redirectOf(() => account.changeEmailAction(form({ email: invited, currentPassword: "secret-password" })))).toMatchObject({ error: expect.stringMatching(/invitation/) });
      const next = email("new");
      const otherDevice = jar.get("wc_session");
      await as(u.id);
      expect(await redirectOf(() => account.changeEmailAction(form({ email: next.toUpperCase(), currentPassword: "secret-password" })))).toMatchObject({ okCode: "email_changed" });
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).email).toBe(next);
      // Every other session ends; this device is signed back in. No sender: no notice.
      expect(await auth.sessionUser(await auth.readSession(otherDevice))).toBeNull();
      expect(await signedIn()).toBe(u.id);
      expect(mail.send).not.toHaveBeenCalled();
    });

    it("with an e-mail sender, a password change or set sends a notice to the member's address (never the password)", async () => {
      const u = await user("admin");
      await as(u.id);
      mail.mailer.mockResolvedValue({ apiKey: "k", from: "noreply@example.com", source: "env" });
      expect(await redirectOf(() => account.setPasswordAction(form({ currentPassword: "secret-password", password: "a-new-password!", confirm: "a-new-password!" })))).toMatchObject({ okCode: "password_changed" });
      expect(mail.send).toHaveBeenCalledTimes(1);
      const notice = (mail.send.mock.calls[0] as unknown as [{ to: string; subject: string; text: string; html: string }])[0];
      expect(notice).toMatchObject({ to: u.email, subject: expect.stringMatching(/mot de passe/) });
      expect(notice.text + notice.html).not.toContain("a-new-password!");
      // A failing sender doesn't block the change.
      mail.send.mockRejectedValueOnce(new Error("smtp down"));
      expect(await redirectOf(() => account.setPasswordAction(form({ currentPassword: "a-new-password!", password: "a-third-password", confirm: "a-third-password" })))).toMatchObject({ okCode: "password_changed" });
      expect(await auth.login(u.email, "a-third-password")).toBe(true);
    });

    it("with an e-mail sender: the change waits for the link sent to the new address (1 hour, this member only)", async () => {
      const u = await user("admin");
      const other = await user("admin");
      await as(u.id);
      mail.mailer.mockResolvedValue({ apiKey: "k", from: "noreply@example.com", source: "env" });
      const next = email("confirm-me");
      expect(await redirectOf(() => account.changeEmailAction(form({ email: next, currentPassword: "secret-password" })))).toMatchObject({ ok: expect.stringMatching(/confirmation/) });
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).email).toBe(u.email);
      const sentTo = (mail.send.mock.calls[0] as unknown as [{ to: string; text: string }])[0];
      expect(sentTo.to).toBe(next);
      const token = /confirm-email\/([A-Za-z0-9_-]+)/.exec(sentTo.text)![1];
      const row = await db.adminUser.findUniqueOrThrow({ where: { id: u.id } });
      expect(row).toMatchObject({ pendingEmail: next, pendingEmailTokenHash: team.hashInviteToken(token) });
      // Another member can't use it; a wrong token neither.
      await as(other.id);
      expect(await redirectOf(() => account.confirmEmailChangeAction(form({ token })))).toMatchObject({ error: expect.stringMatching(/plus valide/) });
      await as(u.id);
      expect(await redirectOf(() => account.confirmEmailChangeAction(form({ token: "wrong" })))).toMatchObject({ error: expect.stringMatching(/plus valide/) });
      const otherDevice = jar.get("wc_session");
      await as(u.id);
      mail.send.mockClear();
      expect(await redirectOf(() => account.confirmEmailChangeAction(form({ token })))).toMatchObject({ ok: expect.stringMatching(/changé/) });
      expect(await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({ email: next, pendingEmail: null, pendingEmailTokenHash: null });
      // A notice to the former address; other sessions end, this device stays signed in.
      expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: u.email, subject: expect.stringMatching(/e-mail de connexion/) }));
      expect(await auth.sessionUser(await auth.readSession(otherDevice))).toBeNull();
      expect(await signedIn()).toBe(u.id);
      // Used once.
      expect(await redirectOf(() => account.confirmEmailChangeAction(form({ token })))).toMatchObject({ error: expect.stringMatching(/plus valide/) });
      // Expired links don't work.
      const later = email("too-late");
      await redirectOf(() => account.changeEmailAction(form({ email: later, currentPassword: "secret-password" })));
      const sentLater = (mail.send.mock.calls as unknown as [{ to: string; text: string }][]).find(([m]) => m.to === later)![0];
      const token2 = /confirm-email\/([A-Za-z0-9_-]+)/.exec(sentLater.text)![1];
      await db.adminUser.update({ where: { id: u.id }, data: { pendingEmailExpiresAt: new Date(Date.now() - 1000) } });
      expect(await redirectOf(() => account.confirmEmailChangeAction(form({ token: token2 })))).toMatchObject({ error: expect.stringMatching(/plus valide/) });
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).email).toBe(next);
    });
  });

  /* ---------------------------------------------------------------- */

  describe("final round: access reset, invitation rate, self changes, re-checked actor", () => {
    const tokenOf = (link: string | undefined) => link!.split("/invite/")[1];

    it("« Réinitialiser l'accès »: password and Google cleared, sessions ended, a reset link (current role / stores) — journaled", async () => {
      const o = await user("owner");
      const s = await store();
      const m = await user("admin", { allStores: false, name: "Mia", googleSub: `${tag}_rs_${n++}`, googleEmail: "mia@gmail.com" });
      await db.storeAccess.create({ data: { userId: m.id, storeId: s.id } });
      await as(m.id);
      const mCookie = jar.get("wc_session");
      await as(o.id);
      mail.mailer.mockResolvedValue({ apiKey: "k", from: "noreply@example.com", source: "env" });
      const res = await teamActions.resetMemberAccessAction({}, form({ memberId: m.id }));
      expect(res).toMatchObject({ ok: expect.stringMatching(/réinitialisé/), link: expect.stringMatching(/\/invite\//) });
      expect(await db.adminUser.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ passwordHash: null, googleSub: null, googleEmail: null, disabledAt: null, role: "admin" });
      expect(await auth.sessionUser(await auth.readSession(mCookie))).toBeNull();
      const row = await db.teamInvite.findUniqueOrThrow({ where: { tokenHash: team.hashInviteToken(tokenOf(res.link)) } });
      expect(row).toMatchObject({ reset: true, email: m.email, role: "admin", allStores: false, storeIds: [s.id], invitedById: o.id });
      expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: m.email, subject: expect.stringMatching(/réinitialisé/), html: expect.stringContaining(res.link!) }));
      expect(await db.eventLog.count({ where: { kind: "team.access_reset", message: { contains: m.email } } })).toBe(1);
      expect(await auth.login(m.email, "secret-password")).toBe(false);
      // A second reset: the first link dies.
      const again = await teamActions.resetMemberAccessAction({}, form({ memberId: m.id }));
      expect((await team.findInviteByToken(tokenOf(res.link)))?.status).toBe("revoked");
      // The link sets a new password (no name asked), signs in; role and stores unchanged; single use.
      jar.clear();
      const token = tokenOf(again.link);
      expect((await redirectOf(() => inviteActions.acceptInviteWithPasswordAction({}, form({ token, password: "brand-new-password", confirm: "brand-new-password" })))).path).toMatch(/^\/dashboard/);
      expect(await signedIn()).toBe(m.id);
      const after = await db.adminUser.findUniqueOrThrow({ where: { id: m.id }, include: { storeAccess: true } });
      expect(after).toMatchObject({ role: "admin", allStores: false, name: "Mia" });
      expect(after.storeAccess.map((a) => a.storeId)).toEqual([s.id]);
      expect(await auth.login(m.email, "brand-new-password")).toBe(true);
      jar.clear();
      expect(await inviteActions.acceptInviteWithPasswordAction({}, form({ token, password: "third-password!", confirm: "third-password!" }))).toMatchObject({ error: team.INVITE_INVALID_ERROR });
      expect(await db.eventLog.count({ where: { kind: "team.access_reset_completed", message: { contains: m.email } } })).toBe(1);
    });

    it("a reset link used with Google links that account (the invited address only); it never changes the role, even if narrowed since", async () => {
      const o = await user("owner");
      const m = await user("admin");
      await as(o.id);
      const res = await teamActions.resetMemberAccessAction({}, form({ memberId: m.id }));
      const row = await db.teamInvite.findUniqueOrThrow({ where: { tokenHash: team.hashInviteToken(tokenOf(res.link)) } });
      // Demoted meanwhile: the link doesn't bring « Admin » back.
      await db.adminUser.update({ where: { id: m.id }, data: { role: "viewer" } });
      expect(await googleCallback({ kind: "invite", inviteId: row.id }, identity(), { inviteToken: tokenOf(res.link) })).toMatchObject({ error: "invite_mismatch" });
      const g = identity({ email: m.email, hd: null });
      expect((await googleCallback({ kind: "invite", inviteId: row.id }, g, { inviteToken: tokenOf(res.link) })).path).toMatch(/^\/dashboard/);
      expect(await signedIn()).toBe(m.id);
      expect(await db.adminUser.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ googleSub: g.sub, googleEmail: m.email, role: "viewer", passwordHash: null });
    });

    it("reset: never oneself, never an owner by an admin, never a member outside a limited admin's stores; a removed member's link is dead", async () => {
      const o = await user("owner");
      const a = await user("admin", { allStores: false });
      const mine = await store();
      const other = await store();
      await db.storeAccess.create({ data: { userId: a.id, storeId: mine.id } });
      const outside = await user("viewer", { allStores: false });
      await db.storeAccess.create({ data: { userId: outside.id, storeId: other.id } });
      await as(a.id);
      expect(await teamActions.resetMemberAccessAction({}, form({ memberId: a.id }))).toMatchObject({ error: TEAM_FLASH.error.reset_self });
      expect(await teamActions.resetMemberAccessAction({}, form({ memberId: o.id }))).toMatchObject({ error: TEAM_FLASH.error.manage_owner });
      expect(await teamActions.resetMemberAccessAction({}, form({ memberId: outside.id }))).toMatchObject({ error: TEAM_FLASH.error.out_of_scope });
      expect(await db.adminUser.findUniqueOrThrow({ where: { id: outside.id } })).toMatchObject({ passwordHash: expect.any(String) });
      // An ordinary invitation for an active member stays refused (only the reset makes a link for one).
      expect(await teamActions.createInviteAction({}, form({ email: outside.email, role: "viewer", storeIds: [mine.id] }))).toMatchObject({ error: expect.stringMatching(/déjà partie/) });
      // Removed after its reset: the link is revoked, and can't bring it back anyway.
      await as(o.id);
      const res = await teamActions.resetMemberAccessAction({}, form({ memberId: outside.id }));
      const row = await db.teamInvite.findUniqueOrThrow({ where: { tokenHash: team.hashInviteToken(tokenOf(res.link)) } });
      await redirectOf(() => teamActions.removeMemberAction(form({ memberId: outside.id })));
      expect((await db.teamInvite.findUniqueOrThrow({ where: { id: row.id } })).revokedAt).toBeInstanceOf(Date);
      await db.teamInvite.update({ where: { id: row.id }, data: { revokedAt: null } });
      expect(await team.joinFromInvite(row, { email: outside.email, passwordHash: "x" })).toMatchObject({ ok: false, code: "invite_invalid" });
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: outside.id } })).disabledAt).toBeInstanceOf(Date);
    });

    it("a reset link can be renewed (« Renvoyer ») while its member is active; the one who sent it must still be able to act on the member", async () => {
      const o = await user("owner");
      const a = await user("admin");
      const v = await user("viewer");
      await as(a.id);
      const res = await teamActions.resetMemberAccessAction({}, form({ memberId: v.id }));
      const row = await db.teamInvite.findUniqueOrThrow({ where: { tokenHash: team.hashInviteToken(tokenOf(res.link)) } });
      const renewed = await teamActions.resendInviteAction({}, form({ inviteId: row.id }));
      expect(renewed.link).toBeTruthy();
      // The admin who sent it is demoted: the link can't be used.
      await db.adminUser.update({ where: { id: a.id }, data: { role: "viewer" } });
      jar.clear();
      expect(await inviteActions.acceptInviteWithPasswordAction({}, form({ token: tokenOf(renewed.link), password: "brand-new-password", confirm: "brand-new-password" }))).toMatchObject({
        error: team.AUTH_ERRORS.inviter_gone,
      });
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: v.id } })).passwordHash).toBeNull();
      void o;
    });

    it("invitation e-mails are limited per member (20 per hour): create, resend and reset refused past it with a friendly message", async () => {
      const o = await user("owner");
      const v = await user("viewer");
      await as(o.id);
      const { row } = await invite({ email: email("rated") });
      limits.allow.mockImplementation(async (key: string) => key !== `team-invite:${o.id}`);
      expect(await teamActions.createInviteAction({}, form({ email: email("rate"), role: "viewer", allStores: "on" }))).toMatchObject({ error: TEAM_FLASH.error.invite_rate });
      expect(await teamActions.resendInviteAction({}, form({ inviteId: row.id }))).toMatchObject({ error: TEAM_FLASH.error.invite_rate });
      expect(await teamActions.resetMemberAccessAction({}, form({ memberId: v.id }))).toMatchObject({ error: TEAM_FLASH.error.invite_rate });
      expect(await db.adminUser.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ passwordHash: expect.any(String) });
      expect(limits.allow).toHaveBeenCalledWith(`team-invite:${o.id}`);
    });

    it("removing oneself: signed out, on /login with « retiré de l'équipe »", async () => {
      const o = await user("owner");
      const a = await user("admin");
      await as(a.id);
      expect(await redirectOf(() => teamActions.removeMemberAction(form({ memberId: a.id })))).toMatchObject({ path: "/login", error: "removed" });
      expect(await signedIn()).toBeNull();
      void o;
    });

    it("an invitation link never replaces a Google account the member already has (read in the transaction)", async () => {
      const m = await user("viewer", { googleSub: `${tag}_has_${n++}` });
      const { row } = await invite({ email: m.email, role: "admin" });
      expect(await team.acceptInviteForMember(row, m.id, { googleSub: `${tag}_other_${n++}`, googleEmail: m.email })).toMatchObject({ ok: false, code: "other_google" });
      expect(await db.teamInvite.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ acceptedAt: null });
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: m.id } })).role).toBe("viewer");
      // Concurrent acceptances of two invitations: both apply (retried on a serialization conflict), never a lost update.
      const s1 = await store();
      const s2 = await store();
      const w = await user("viewer", { allStores: false });
      const i1 = await invite({ email: w.email, role: "viewer", allStores: false, storeIds: [s1.id] });
      const i2 = await invite({ email: w.email, role: "viewer", allStores: false, storeIds: [s2.id] });
      const results = await Promise.all([team.acceptInviteForMember(i1.row, w.id), team.acceptInviteForMember(i2.row, w.id)]);
      expect(results).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
      const access = (await db.storeAccess.findMany({ where: { userId: w.id } })).map((a) => a.storeId).sort();
      expect(access).toEqual([s1.id, s2.id].sort());
    });

    it("with an e-mail sender too, an address with a pending invitation / authorized e-mail can't become one's sign-in e-mail", async () => {
      const u = await user("admin");
      await as(u.id);
      mail.mailer.mockResolvedValue({ apiKey: "k", from: "noreply@example.com", source: "env" });
      const invited = email("pending-owner");
      await invite({ email: invited, role: "owner" });
      expect(await redirectOf(() => account.changeEmailAction(form({ email: invited, currentPassword: "secret-password" })))).toMatchObject({ errorCode: "email_pending_entry" });
      expect(mail.send).not.toHaveBeenCalled();
      // An entry created after the confirmation was sent: the confirmation is refused too.
      const later = email("later-entry");
      await redirectOf(() => account.changeEmailAction(form({ email: later, currentPassword: "secret-password" })));
      const token = /confirm-email\/([A-Za-z0-9_-]+)/.exec((mail.send.mock.calls[0] as unknown as [{ text: string }])[0].text)![1];
      await invite({ email: later, role: "owner", token: false });
      expect(await redirectOf(() => account.confirmEmailChangeAction(form({ token })))).toMatchObject({ errorCode: "email_pending_entry" });
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).email).toBe(u.email);
    });

    it("member changes re-read the acting member inside the transaction (a session that still says admin isn't trusted)", async () => {
      const o = await user("owner");
      const a = await user("admin");
      const v = await user("viewer");
      await as(a.id);
      // The session check sees an admin; by the time the change is made, it was demoted.
      const realFind = db.adminUser.findUnique.bind(db.adminUser);
      const spy = vi.spyOn(db.adminUser, "findUnique").mockImplementationOnce((async (args: Parameters<typeof realFind>[0]) => {
        const row = await realFind(args);
        await db.adminUser.update({ where: { id: a.id }, data: { role: "viewer" } });
        return row;
      }) as never);
      try {
        expect(await redirectOf(() => teamActions.removeMemberAction(form({ memberId: v.id })))).toMatchObject({ errorCode: "actor_changed" });
      } finally {
        spy.mockRestore();
      }
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: v.id } })).disabledAt).toBeNull();
      void o;
    });
  });

  /* ---------------------------------------------------------------- */

  describe("password login", () => {
    it("an unknown e-mail, a Google-only or a removed account still costs one bcrypt comparison (no timing oracle)", async () => {
      const bcrypt = (await import("bcryptjs")).default;
      const spy = vi.spyOn(bcrypt, "compare");
      try {
        const gonly = await db.adminUser.create({ data: { email: email("gonly-timing"), role: "admin", googleSub: `${tag}_t_${n++}` } });
        const removed = await user("admin", { disabledAt: new Date() });
        for (const e of [email("nobody"), gonly.email, removed.email]) {
          spy.mockClear();
          expect(await auth.login(e, "secret-password")).toBe(false);
          expect(spy).toHaveBeenCalledTimes(1);
        }
      } finally {
        spy.mockRestore();
      }
    });

    it("/login's action: `next` is honored when it is a path of this site only", async () => {
      const { passwordLoginAction } = await import("@/app/login/actions");
      const u = await user("admin");
      expect(await redirectOf(() => passwordLoginAction({}, form({ email: u.email, password: "secret-password", next: "/invite/abc" })))).toMatchObject({ path: "/invite/abc" });
      jar.clear();
      expect((await redirectOf(() => passwordLoginAction({}, form({ email: u.email, password: "secret-password", next: "//evil.example/x" })))).path).toMatch(/^\/dashboard/);
      jar.clear();
      expect(await passwordLoginAction({}, form({ email: u.email, password: "wrong" }))).toMatchObject({ error: expect.stringMatching(/incorrect/), email: u.email });
    });
  });
});
