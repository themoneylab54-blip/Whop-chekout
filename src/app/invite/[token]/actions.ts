"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentUser, hashPassword, logout, signIn } from "@/lib/auth";
import { recordTeamEvent, ROLE_LABELS } from "@/lib/access";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { acceptInviteForMember, AUTH_ERRORS, findInviteByToken, INVITE_INVALID_ERROR, joinFromInvite, landingPath, passwordProblem, type AuthErrorCode } from "@/lib/team";

export type AcceptState = { error?: string; name?: string };

const tokenOf = (fd: FormData) => String(fd.get("token") ?? "").slice(0, 200);

/** Back to the invitation's page with an error code (fixed message there). */
function backToInvite(token: string, code: AuthErrorCode): never {
  redirect(`/invite/${encodeURIComponent(token)}?error=${code}`);
}

/** « Créer un mot de passe »: joins the team with the invited e-mail, then signs in. Used with useActionState. */
export async function acceptInviteWithPasswordAction(_prev: AcceptState, fd: FormData): Promise<AcceptState> {
  const token = tokenOf(fd);
  const name = String(fd.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const password = String(fd.get("password") ?? "");
  if (!(await rateLimit(`invite-accept:${clientIp(await headers())}`, 10))) return { error: AUTH_ERRORS.rate, name };
  const found = await findInviteByToken(token);
  if (!found || found.status !== "pending") return { error: INVITE_INVALID_ERROR, name };
  // An access-reset link sets a new password on an existing member (its name is already known).
  if (!name && !found.invite.reset) return { error: "Indiquez votre nom.", name };
  const problem = passwordProblem(password);
  if (problem) return { error: problem, name };
  if (password !== String(fd.get("confirm") ?? "")) return { error: "Les deux mots de passe ne correspondent pas.", name };
  const joined = await joinFromInvite(found.invite, { email: found.invite.email, name: name || null, passwordHash: await hashPassword(password) });
  if (!joined.ok) return { error: joined.error, name };
  if (!(await signIn(joined.userId))) return { error: INVITE_INVALID_ERROR, name };
  await recordTeamEvent({
    kind: "team.login",
    message: `${found.invite.email} s'est connecté (${found.invite.reset ? "accès réinitialisé" : "invitation acceptée"}).`,
    actorId: joined.userId,
    data: { method: "password" },
  });
  redirect(await landingPath(joined.userId));
}

/**
 * Already signed in with the invited e-mail: the invitation adds its access and is used up — see
 * acceptInviteForMember (read and checked in one transaction: the member as it is now, what the
 * inviter may still grant, a role raised only when the inviter could grant it on everything the
 * member ends up with).
 */
export async function acceptInviteAsMemberAction(fd: FormData) {
  const token = tokenOf(fd);
  const user = await currentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
  const found = await findInviteByToken(token);
  if (!found || found.status !== "pending") backToInvite(token, "invite_invalid");
  const { invite } = found;
  if (invite.email !== user.email) backToInvite(token, "wrong_account");
  const accepted = await acceptInviteForMember(invite, user.id);
  if (!accepted.ok) backToInvite(token, accepted.code);
  await recordTeamEvent({
    kind: "team.invite_accepted",
    message: `${user.email} a accepté une invitation (${ROLE_LABELS[accepted.role]}).`,
    actorId: user.id,
    data: { inviteId: invite.id, role: accepted.role, from: accepted.from },
  });
  redirect(await landingPath(user.id));
}

/** Signed in with another address: signs out and comes back to the invitation. */
export async function signOutForInviteAction(fd: FormData) {
  const token = tokenOf(fd);
  await logout();
  redirect(`/invite/${encodeURIComponent(token)}`);
}
