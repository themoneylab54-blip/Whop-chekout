import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { env } from "@/lib/env";
import { accountPasswordAllowed, currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { route } from "@/lib/route";
import { flashUrl } from "@/lib/flash";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { strictSameOrigin } from "@/lib/stripe-state";
import {
  GOOGLE_COOKIE_PATH,
  GOOGLE_INVITE_COOKIE,
  GOOGLE_NONCE_COOKIE,
  GOOGLE_REAUTH_MAX_AGE_MS,
  GOOGLE_STATE_TTL_MS,
  googleAuthConfigured,
  googleAuthorizeUrl,
  newGoogleNonce,
  signGoogleState,
  type GoogleMode,
} from "@/lib/google-auth";
import { findInviteByToken, safeNext, type AuthErrorCode } from "@/lib/team";
import { loginUrl, type AccountErrorCode } from "@/lib/team-rules";

export const dynamic = "force-dynamic";

const ACCOUNT = "/dashboard/account";

/**
 * « Continuer avec Google » / « Lier mon compte Google » / « Confirmer avec Google » (a form POST
 * from our own pages: Origin, or without it `Sec-Fetch-Site: same-origin`, required): signs a state
 * for the mode bound to a nonce kept in a short-lived cookie of this browser, then sends it to
 * Google's account chooser.
 *   login  → `next` (a path of this site, checked with safeNext) travels in the signed state: the
 *            callback lands there;
 *   link   → the signed-in member's current password (or, without one, a fresh Google re-authentication
 *            done just before) is required; Google must ask for its password again (max_age=0);
 *   reauth → the signed-in member re-authenticates with its linked Google account (max_age=0);
 *   invite → a pending invitation's token; a failure comes back to that invitation's page (the token
 *            travels in an httpOnly cookie of this browser, never in the state nor the logs).
 * Every error is a code (fixed messages on /login, /invite and Profil).
 */
async function handle(req: Request) {
  if (!strictSameOrigin(req.headers.get("origin"), req.headers.get("sec-fetch-site"), env.appUrl)) return new NextResponse("Origine refusée", { status: 403 });
  const form = await req.formData().catch(() => null);
  const mode = String(form?.get("mode") ?? "login");
  const signedInMode = mode === "link" || mode === "reauth";
  const token = mode === "invite" ? String(form?.get("token") ?? "") : "";
  const next = mode === "login" ? safeNext(String(form?.get("next") ?? "")) : null;
  const to = (path: string) => NextResponse.redirect(`${env.appUrl}${path}`, 303);
  const login = (code?: AuthErrorCode) => to(loginUrl(code, next));
  const account = (error: AccountErrorCode) => to(flashUrl(ACCOUNT, { error }));
  const invitePage = (code: AuthErrorCode) => to(`/invite/${encodeURIComponent(token)}?error=${code}`);
  const refuse = (code: AuthErrorCode) => (signedInMode ? account(code) : mode === "invite" && token ? invitePage(code) : login(code));
  if (!googleAuthConfigured()) return refuse("google_off");
  if (!(await rateLimit(`google-start:${clientIp(req)}`, 20))) return refuse("rate");

  let googleMode: GoogleMode;
  if (signedInMode) {
    const user = await currentUser();
    if (!user) return login();
    if (mode === "reauth") {
      if (!user.googleLinked) return account("no_google");
      googleMode = { kind: "reauth", userId: user.id };
    } else {
      // Adding a way in needs the current password — or, for an account without one, a fresh Google re-authentication.
      if (!(await accountPasswordAllowed(user.id))) return account("rate");
      const row = await db.adminUser.findUnique({ where: { id: user.id }, select: { passwordHash: true, reauthAt: true } });
      if (row?.passwordHash) {
        const password = String(form?.get("currentPassword") ?? "");
        if (!password || !(await bcrypt.compare(password, row.passwordHash))) return account("link_password");
      } else {
        const fresh = row?.reauthAt && Date.now() - row.reauthAt.getTime() <= GOOGLE_REAUTH_MAX_AGE_MS;
        if (!fresh) return account("link_reauth_first");
        // Used once.
        await db.adminUser.update({ where: { id: user.id }, data: { reauthAt: null } });
      }
      googleMode = { kind: "link", userId: user.id };
    }
  } else if (mode === "invite") {
    const found = await findInviteByToken(token);
    if (!found || found.status !== "pending") return found ? invitePage("invite_invalid") : login("invite_invalid");
    googleMode = { kind: "invite", inviteId: found.invite.id };
  } else {
    if (await currentUser()) return to(next ?? "/dashboard");
    googleMode = next ? { kind: "login", next } : { kind: "login" };
  }

  const nonce = newGoogleNonce();
  const res = NextResponse.redirect(googleAuthorizeUrl(signGoogleState(googleMode, nonce), nonce, { fresh: signedInMode }), 303);
  const cookie = {
    httpOnly: true,
    secure: env.appUrl.startsWith("https://"),
    // Google sends the browser back with a top-level GET: a lax cookie comes along.
    sameSite: "lax" as const,
    path: GOOGLE_COOKIE_PATH,
    maxAge: Math.floor(GOOGLE_STATE_TTL_MS / 1000),
  };
  res.cookies.set(GOOGLE_NONCE_COOKIE, nonce, cookie);
  if (googleMode.kind === "invite") res.cookies.set(GOOGLE_INVITE_COOKIE, token, cookie);
  else res.cookies.set(GOOGLE_INVITE_COOKIE, "", { ...cookie, maxAge: 0 });
  return res;
}

export const POST = route("auth.google.start", handle);

/** A bookmark or an old link: the buttons are forms (POST). */
export const GET = route("auth.google.start_get", async () => NextResponse.redirect(`${env.appUrl}/login`));
