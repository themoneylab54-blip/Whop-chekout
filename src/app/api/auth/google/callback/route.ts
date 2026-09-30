import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { currentUser, signIn } from "@/lib/auth";
import { recordTeamEvent } from "@/lib/access";
import { route } from "@/lib/route";
import { flashUrl } from "@/lib/flash";
import { log } from "@/lib/log";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { GOOGLE_COOKIE_PATH, GOOGLE_INVITE_COOKIE, GOOGLE_NONCE_COOKIE, googleIdentityFromCode, verifyGoogleState, type GoogleIdentity } from "@/lib/google-auth";
import { hashInviteToken, landingPath, linkGoogleAccount, recordGoogleReauth, resolveGoogleSignIn, safeNext, type AuthErrorCode } from "@/lib/team";
import { loginUrl, type AccountErrorCode, type AccountOkCode } from "@/lib/team-rules";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const ACCOUNT = "/dashboard/account";

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Google's redirect after « Continuer avec Google »: checks the state against this browser's nonce
 * cookie (always cleared, with the invitation cookie), exchanges the code, verifies the ID token, then
 *   link    → attaches the Google account to the signed-in member (the one the state was issued to);
 *             its other sessions end, this device stays signed in;
 *   reauth  → the member's own Google account, freshly signed in: stamps the re-authentication;
 *   login / invitation → signs in the member with that Google account or verified e-mail, or lets a
 *             pending invitation / authorized e-mail join (see resolveGoogleSignIn).
 * A sign-in lands on the state's `next` (a path of this site) when it has one. Refusals go back to
 * /login (keeping `next`) — or to the invitation's page — and Profil, always as a code (fixed
 * message); only codes are logged. Rate limited per IP; tokens are never kept nor logged.
 */
async function handle(req: Request) {
  const q = new URL(req.url).searchParams;
  const clear = (res: NextResponse) => {
    res.cookies.set(GOOGLE_NONCE_COOKIE, "", { path: GOOGLE_COOKIE_PATH, maxAge: 0 });
    res.cookies.set(GOOGLE_INVITE_COOKIE, "", { path: GOOGLE_COOKIE_PATH, maxAge: 0 });
    return res;
  };
  const to = (path: string, params: { ok?: AccountOkCode; error?: AccountErrorCode } = {}, hash = "") => clear(NextResponse.redirect(`${env.appUrl}${flashUrl(path, params, hash)}`));
  const go = (path: string) => clear(NextResponse.redirect(`${env.appUrl}${path}`));

  if (!(await rateLimit(`google-callback:${clientIp(req)}`, 20))) return go(loginUrl("rate"));
  const verified = verifyGoogleState(q.get("state") ?? "", cookieValue(req, GOOGLE_NONCE_COOKIE));
  if (!verified) {
    log.warn("auth.google_bad_state", "Google sign-in callback with an invalid, expired or foreign state");
    return go(loginUrl("state"));
  }
  const { mode } = verified;
  // Where the member was headed (signed in the state, checked again): kept through a refusal too.
  const next = mode.kind === "login" ? safeNext(mode.next) : null;

  // An invitation's failures go back to its page: the token comes from this browser's cookie, and
  // only when it is that invitation's.
  let invitePath: string | null = null;
  if (mode.kind === "invite") {
    const token = cookieValue(req, GOOGLE_INVITE_COOKIE);
    if (token && token.length <= 200) {
      const row = await db.teamInvite.findUnique({ where: { tokenHash: hashInviteToken(token) }, select: { id: true } });
      if (row?.id === mode.inviteId) invitePath = `/invite/${encodeURIComponent(token)}`;
    }
  }
  const signedInMode = mode.kind === "link" || mode.kind === "reauth";
  const fail = (code: AuthErrorCode) => (signedInMode ? to(ACCOUNT, { error: code }) : go(invitePath ? `${invitePath}?error=${code}` : loginUrl(code, next)));

  const oauthError = q.get("error");
  if (oauthError) return fail(oauthError === "access_denied" ? "cancelled" : "google_error");
  const code = q.get("code");
  if (!code) return fail("bad_response");

  // A link / re-authentication belongs to the member who started it (still signed in, same session).
  const member = signedInMode ? await currentUser() : null;
  if (signedInMode && member?.id !== mode.userId) return go(loginUrl("session"));

  let identity: GoogleIdentity;
  try {
    identity = await googleIdentityFromCode(code, verified.nonce);
  } catch (err) {
    log.warn("auth.google_failed", "Google sign-in: code exchange or ID token refused", { err: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
    return fail("google_failed");
  }

  if (member && mode.kind === "reauth") {
    const done = await recordGoogleReauth(member.id, identity);
    return done.ok ? to(ACCOUNT, { ok: "reauth_ok" }, "#mot-de-passe") : to(ACCOUNT, { error: done.code });
  }
  if (member) {
    const linked = await linkGoogleAccount(member, identity);
    if (!linked.ok) return to(ACCOUNT, { error: linked.code });
    // Its other sessions ended with the link: this device stays signed in.
    if (linked.changed) await signIn(member.id);
    return to(ACCOUNT, { ok: "google_linked" });
  }

  const outcome = await resolveGoogleSignIn(identity, mode.kind === "invite" ? mode.inviteId : undefined);
  if (!outcome.ok) {
    log.info("auth.google_refused", "Google sign-in refused", { reason: outcome.code });
    return fail(outcome.code);
  }
  if (!(await signIn(outcome.userId))) return fail("removed");
  await recordTeamEvent({ kind: "team.login", message: `${identity.email} s'est connecté avec Google.`, actorId: outcome.userId, data: { method: "google", how: outcome.how } });
  return go(await landingPath(outcome.userId, next));
}

export const GET = route("auth.google.callback", handle);
