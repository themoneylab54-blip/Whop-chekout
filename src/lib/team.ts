import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { Prisma, type AdminUser, type TeamInvite, type UserRole } from "@prisma/client";
import type { SessionUser } from "./auth";
import { accessibleStoreWhere, canGrantRole, canManageMember, recordTeamEvent, roleAtLeast, ROLE_LABELS } from "./access";
import { db } from "./db";
import { env } from "./env";
import { freshGoogleAuth, type GoogleIdentity } from "./google-auth";
import { AUTH_ERRORS, googleProvesEmail, type AuthErrorCode } from "./team-rules";

export {
  PASSWORD_MIN,
  PASSWORD_MAX_BYTES,
  PASSWORD_TOO_LONG_ERROR,
  passwordProblem,
  NOT_AUTHORIZED_ERROR,
  REMOVED_ERROR,
  INVITE_INVALID_ERROR,
  ALREADY_MEMBER_ERROR,
  GOOGLE_TAKEN_ERROR,
  AUTH_ERRORS,
  authErrorMessage,
  safeNext,
  googleProvesEmail,
  type AuthErrorCode,
} from "./team-rules";

/*
 * Joining the team: invitations (a token sent by e-mail, 7 days, single use), authorized e-mails (no
 * token: that address may sign in with Google), and « Continuer avec Google » (sign in, link, join).
 *
 * Who may join through an entry is re-checked when it is used: the member who created it must still
 * be active and still allowed to grant that role and those stores (an entry whose inviter is gone is
 * refused: an owner must send a new one — « Renvoyer » makes the owner its inviter).
 */

export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A fresh invitation token (only ever in the link) and the hash stored in its place. */
export function newInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function inviteUrl(token: string): string {
  return `${env.appUrl}/invite/${token}`;
}

export type InviteStatus = "pending" | "expired" | "accepted" | "revoked";

/** Where an invitation (token) or an authorized e-mail (no token: never expires, never used up) stands. Pure. */
export function inviteStatus(invite: Pick<TeamInvite, "tokenHash" | "expiresAt" | "acceptedAt" | "revokedAt">, now = new Date()): InviteStatus {
  if (invite.revokedAt) return "revoked";
  if (!invite.tokenHash) return "pending";
  if (invite.acceptedAt) return "accepted";
  if (!invite.expiresAt || invite.expiresAt <= now) return "expired";
  return "pending";
}

export type InviteWithInviter = TeamInvite & { invitedBy: { name: string | null; email: string } | null };

/** The invitation behind a link's token, with where it stands (null: no such token). */
export async function findInviteByToken(token: string): Promise<{ invite: InviteWithInviter; status: InviteStatus } | null> {
  if (!token || token.length > 200) return null;
  const invite = await db.teamInvite.findUnique({ where: { tokenHash: hashInviteToken(token) }, include: { invitedBy: { select: { name: true, email: true } } } });
  return invite ? { invite, status: inviteStatus(invite) } : null;
}

/** A usable way in for `email`: its newest pending invitation, else an authorized-e-mail entry. */
export async function pendingInviteForEmail(email: string, now = new Date()): Promise<TeamInvite | null> {
  const invite = await db.teamInvite.findFirst({
    where: { email, tokenHash: { not: null }, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  return invite ?? (await db.teamInvite.findFirst({ where: { email, tokenHash: null, revokedAt: null }, orderBy: { createdAt: "desc" } }));
}

/* ------------------------------------------------------------------ */
/* Who may grant what                                                  */
/* ------------------------------------------------------------------ */

export type Granter = { role: UserRole; allStores: boolean; storeIds: readonly string[] };
export type Grant = { role: UserRole; allStores: boolean; storeIds: readonly string[] };

/**
 * `granter` may give `grant` (role and stores): a role it may grant, and « toutes les boutiques »
 * or stores outside its own scope only from someone who sees every store. Pure.
 */
export function canGrantAccess(granter: Granter, grant: Grant): boolean {
  if (!canGrantRole(granter.role, grant.role)) return false;
  if (granter.allStores || granter.role === "owner") return true;
  if (grant.allStores || grant.role === "owner") return false;
  return grant.storeIds.every((id) => granter.storeIds.includes(id));
}

type Client = Prisma.TransactionClient | typeof db;

/** A serialization failure of a Serializable transaction (Postgres 40001 / deadlock): safe to run again. */
export function isSerializationConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034";
}

/**
 * Runs `fn` in a Serializable transaction, again (up to `attempts` times in all) when it lost a
 * serialization conflict to a concurrent one; the last conflict is thrown.
 */
export async function serializableTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await db.$transaction(fn, { isolationLevel: "Serializable" });
    } catch (err) {
      if (i >= attempts || !isSerializationConflict(err)) throw err;
      await new Promise((r) => setTimeout(r, 20 * i + Math.floor(Math.random() * 30)));
    }
  }
}

/** A member's granting power (null: unknown or removed). */
async function granterOf(client: Client, userId: string | null): Promise<Granter | null> {
  if (!userId) return null;
  const u = await client.adminUser.findUnique({ where: { id: userId }, select: { role: true, allStores: true, disabledAt: true, storeAccess: { select: { storeId: true } } } });
  return u && !u.disabledAt ? { role: u.role, allStores: u.allStores, storeIds: u.storeAccess.map((a) => a.storeId) } : null;
}

/**
 * `granter` may still change `member` (role and every store it sees): used when an access-reset link
 * is used — the member who sent it must still be allowed to act on that member. Pure.
 */
export function granterCanManage(granter: Granter, member: { role: UserRole; allStores: boolean; storeIds: readonly string[] }): boolean {
  if (!canManageMember(granter, member)) return false;
  if (granter.allStores || granter.role === "owner") return true;
  if (member.allStores || member.role === "owner") return false;
  return member.storeIds.every((id) => granter.storeIds.includes(id));
}

/** An entry's grant, limited to the stores that still exist (a deleted store's access rows are gone too). */
async function liveGrant(client: Client, invite: Pick<TeamInvite, "role" | "allStores" | "storeIds">, existing?: Set<string>): Promise<Grant> {
  const ids = existing ?? new Set((await client.store.findMany({ where: { id: { in: invite.storeIds } }, select: { id: true } })).map((s) => s.id));
  return { role: invite.role, allStores: invite.allStores, storeIds: invite.storeIds.filter((id) => ids.has(id)) };
}

/** A grant limited to some stores none of which exists any more: it opens nothing. Pure. */
export function grantsNothing(grant: Grant): boolean {
  return !grant.allStores && grant.role !== "owner" && grant.storeIds.length === 0;
}

/** The member who created `invite` is still active and may still grant its role and stores. */
export async function inviterStillAllowed(client: Client, invite: Pick<TeamInvite, "invitedById" | "role" | "allStores" | "storeIds">): Promise<boolean> {
  const granter = await granterOf(client, invite.invitedById);
  return !!granter && canGrantAccess(granter, await liveGrant(client, invite));
}

/**
 * After `userId` was removed, demoted or narrowed: revokes the pending invitations and authorized
 * e-mails it created that it can no longer grant (all of them once removed). Returns how many.
 */
export async function revokeUngrantableInvites(client: Client, userId: string, now = new Date()): Promise<number> {
  const invites = await client.teamInvite.findMany({ where: { invitedById: userId, revokedAt: null, acceptedAt: null } });
  if (!invites.length) return 0;
  const granter = await granterOf(client, userId);
  const existing = new Set((await client.store.findMany({ where: { id: { in: invites.flatMap((i) => i.storeIds) } }, select: { id: true } })).map((s) => s.id));
  const stale: string[] = [];
  for (const i of invites) if (!granter || !canGrantAccess(granter, await liveGrant(client, i, existing))) stale.push(i.id);
  if (stale.length) await client.teamInvite.updateMany({ where: { id: { in: stale }, revokedAt: null }, data: { revokedAt: now } });
  return stale.length;
}

/* ------------------------------------------------------------------ */
/* Joining                                                             */
/* ------------------------------------------------------------------ */

export type Refusal = { ok: false; code: AuthErrorCode; error: string };
const refusal = (code: AuthErrorCode): Refusal => ({ ok: false, code, error: AUTH_ERRORS[code] });

class JoinRefused extends Error {
  constructor(public code: AuthErrorCode) {
    super(code);
  }
}

/**
 * Joins the team through `invite` (invitation or authorized e-mail), in one transaction: creates the
 * user with the invite's role and stores (those that still exist), or brings back a removed member
 * with that e-mail (with only the credentials given here); a token invitation is used up (a second
 * use, even concurrent, is refused); the entry records who used it. Refused: an active member with
 * that e-mail, an inviter no longer allowed to grant that access.
 */
export async function joinFromInvite(
  invite: TeamInvite,
  who: { email: string; googleSub?: string; googleEmail?: string; name?: string | null; avatarUrl?: string | null; passwordHash?: string },
): Promise<{ ok: true; userId: string } | Refusal> {
  const now = new Date();
  const email = who.email.trim().toLowerCase();
  if (email !== invite.email) return refusal("invite_invalid");
  // An access-reset link only gives an active member a new way in (never a new account, never a
  // removed member back).
  if (invite.reset) return completeAccessReset(invite, who);
  // Owners see everything.
  const allStores = invite.role === "owner" || invite.allStores;
  try {
    const userId = await db.$transaction(async (tx) => {
      if (invite.tokenHash) {
        const claimed = await tx.teamInvite.updateMany({ where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { acceptedAt: now } });
        if (!claimed.count) throw new JoinRefused("invite_invalid");
      } else if (!(await tx.teamInvite.count({ where: { id: invite.id, revokedAt: null } }))) {
        throw new JoinRefused("not_authorized");
      }
      if (!(await inviterStillAllowed(tx, invite))) throw new JoinRefused("inviter_gone");
      // Every store it was for was deleted since: it opens nothing.
      if (grantsNothing(await liveGrant(tx, invite))) throw new JoinRefused("invite_invalid");
      const existing = await tx.adminUser.findUnique({ where: { email } });
      if (existing && !existing.disabledAt) throw new JoinRefused("already_member");
      const data = {
        role: invite.role,
        allStores,
        // Only the way in used now: a removed member's former password / Google account don't come back.
        googleSub: who.googleSub ?? null,
        googleEmail: who.googleSub ? (who.googleEmail ?? email) : null,
        passwordHash: who.passwordHash ?? null,
      };
      let id: string;
      if (existing) {
        // A removed member invited again: back in, with this invitation's access only.
        await tx.adminUser.update({
          where: { id: existing.id },
          data: { ...data, disabledAt: null, sessionVersion: { increment: 1 }, name: existing.name ?? who.name ?? null, avatarUrl: existing.avatarUrl ?? who.avatarUrl ?? null },
        });
        await tx.storeAccess.deleteMany({ where: { userId: existing.id } });
        id = existing.id;
      } else {
        id = (await tx.adminUser.create({ data: { email, name: who.name ?? null, avatarUrl: who.avatarUrl ?? null, ...data }, select: { id: true } })).id;
      }
      if (!allStores && invite.storeIds.length) {
        const stores = await tx.store.findMany({ where: { id: { in: invite.storeIds } }, select: { id: true } });
        if (stores.length) await tx.storeAccess.createMany({ data: stores.map((s) => ({ userId: id, storeId: s.id })), skipDuplicates: true });
      }
      await tx.teamInvite.update({ where: { id: invite.id }, data: { usedById: id } });
      // The address's other invitation links die with this join (authorized e-mails stay): a second
      // invitation, from someone else, can't be stacked on top of this access afterwards.
      await tx.teamInvite.updateMany({ where: { email, id: { not: invite.id }, tokenHash: { not: null }, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });
      return id;
    });
    await recordTeamEvent({
      kind: "team.member_joined",
      message: `${email} a rejoint l'équipe (${ROLE_LABELS[invite.role]}) ${invite.tokenHash ? "par invitation" : "via un e-mail autorisé"}${who.googleSub ? " avec Google" : ""}.`,
      actorId: userId,
      data: { inviteId: invite.id, invitedById: invite.invitedById, role: invite.role, method: who.googleSub ? "google" : "password" },
    });
    return { ok: true, userId };
  } catch (err) {
    if (err instanceof JoinRefused) return refusal(err.code);
    // Created meanwhile (same e-mail or Google account in another tab): the other attempt won.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return refusal("already_member");
    throw err;
  }
}

/**
 * A signed-in (or Google-identified) active member with the invited e-mail uses `invite` (a token
 * invitation), in one Serializable transaction (run again after a serialization conflict): the
 * invitation is used up (acceptedAt, usedById — a second use, even concurrent, is refused) and its
 * access added (never removes any: a higher role or more stores are kept) — while its inviter may
 * still grant it, and may grant what the member ends up with: a role raised through it over every
 * store the member has, the stores added at the member's role (else `invite_exceeds`); an invitation
 * whose stores were all deleted opens nothing (`invite_invalid`). An access-reset link adds nothing.
 * `link`: the Google account the invitation link was used with is attached in the same transaction
 * (its other sessions end) — refused when the member already has another Google account.
 */
export async function acceptInviteForMember(
  invite: TeamInvite,
  userId: string,
  link?: { googleSub: string; googleEmail: string },
): Promise<{ ok: true; role: UserRole; from: UserRole } | Refusal> {
  const now = new Date();
  try {
    return await serializableTx(async (tx) => {
      // Everything is read inside the transaction: the member as it is now, not as its session saw it.
      const user = await tx.adminUser.findUnique({
        where: { id: userId },
        select: { email: true, role: true, allStores: true, disabledAt: true, googleSub: true, storeAccess: { select: { storeId: true } } },
      });
      if (!user || user.disabledAt || user.email !== invite.email) throw new JoinRefused("invite_invalid");
      // Another Google account linked meanwhile: never replaced through an invitation.
      if (link && user.googleSub && user.googleSub !== link.googleSub) throw new JoinRefused("other_google");
      const claimed = await tx.teamInvite.updateMany({
        where: { id: invite.id, tokenHash: { not: null }, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now, usedById: userId },
      });
      // Thrown (not returned) from here on: the claim is rolled back, the invitation stays pending.
      if (!claimed.count) throw new JoinRefused("invite_invalid");
      const granter = await granterOf(tx, invite.invitedById);
      const linkData = link && user.googleSub !== link.googleSub ? { googleSub: link.googleSub, googleEmail: link.googleEmail, sessionVersion: { increment: 1 } } : link ? { googleEmail: link.googleEmail } : null;
      if (invite.reset) {
        // Used by a member already back in: nothing to add, the link is simply used up.
        const current = user.storeAccess.map((a) => a.storeId);
        if (!granter || !granterCanManage(granter, { role: user.role, allStores: user.allStores, storeIds: current })) throw new JoinRefused("inviter_gone");
        if (linkData) await tx.adminUser.update({ where: { id: userId }, data: linkData });
        return { ok: true as const, role: user.role, from: user.role };
      }
      const grant = await liveGrant(tx, invite);
      if (!granter || !canGrantAccess(granter, grant)) throw new JoinRefused("inviter_gone");
      if (grantsNothing(grant)) throw new JoinRefused("invite_invalid");
      const current = user.storeAccess.map((a) => a.storeId);
      const role = roleAtLeast(user.role, grant.role) ? user.role : grant.role;
      const allStores = user.allStores || grant.allStores || role === "owner";
      const storeIds = allStores ? [] : [...new Set([...current, ...grant.storeIds])];
      // The inviter must be able to grant what this member ends up with through it: a raised role
      // applies to every store the member has, and the stores added come with the member's role.
      const added = storeIds.filter((id) => !current.includes(id));
      const changes = role !== user.role || allStores !== user.allStores || added.length > 0;
      const needed: Grant = role !== user.role ? { role, allStores, storeIds } : { role, allStores: grant.allStores, storeIds: grant.storeIds };
      if (changes && !canGrantAccess(granter, needed)) throw new JoinRefused("invite_exceeds");
      // Only what changes is written.
      const data = { ...(role !== user.role ? { role } : {}), ...(allStores !== user.allStores ? { allStores } : {}), ...linkData };
      if (Object.keys(data).length) await tx.adminUser.update({ where: { id: userId }, data });
      if (added.length) await tx.storeAccess.createMany({ data: added.map((storeId) => ({ userId, storeId })), skipDuplicates: true });
      return { ok: true as const, role, from: user.role };
    });
  } catch (err) {
    if (err instanceof JoinRefused) return refusal(err.code);
    // That Google account was linked to another member meanwhile.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return refusal("google_taken");
    if (isSerializationConflict(err)) return refusal("conflict");
    throw err;
  }
}

/**
 * Uses an access-reset link (« Réinitialiser l'accès », see TeamInvite.reset) in one Serializable
 * transaction: the active member with the invited e-mail gets the new way in given here (a password,
 * or the Google account the link was used with) and its other sessions end; its role and stores are
 * left as they are. Refused: a used / expired / revoked link, a removed member, a sender no longer
 * allowed to act on that member, a Google account other than the one already linked.
 */
export async function completeAccessReset(
  invite: TeamInvite,
  who: { email?: string; googleSub?: string; googleEmail?: string; passwordHash?: string },
): Promise<{ ok: true; userId: string } | Refusal> {
  if (!invite.reset || !invite.tokenHash) return refusal("invite_invalid");
  if (!who.passwordHash && !who.googleSub) return refusal("invite_invalid");
  const now = new Date();
  try {
    const userId = await serializableTx(async (tx) => {
      const claimed = await tx.teamInvite.updateMany({
        where: { id: invite.id, reset: true, tokenHash: { not: null }, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now },
      });
      if (!claimed.count) throw new JoinRefused("invite_invalid");
      const user = await tx.adminUser.findUnique({
        where: { email: invite.email },
        select: { id: true, role: true, allStores: true, disabledAt: true, googleSub: true, storeAccess: { select: { storeId: true } } },
      });
      if (!user || user.disabledAt) throw new JoinRefused("invite_invalid");
      const granter = await granterOf(tx, invite.invitedById);
      if (!granter || !granterCanManage(granter, { role: user.role, allStores: user.allStores, storeIds: user.storeAccess.map((a) => a.storeId) })) {
        throw new JoinRefused("inviter_gone");
      }
      if (who.googleSub && user.googleSub && user.googleSub !== who.googleSub) throw new JoinRefused("other_google");
      await tx.adminUser.update({
        where: { id: user.id },
        data: {
          ...(who.passwordHash ? { passwordHash: who.passwordHash } : {}),
          ...(who.googleSub ? { googleSub: who.googleSub, googleEmail: who.googleEmail ?? invite.email } : {}),
          reauthAt: null,
          sessionVersion: { increment: 1 },
        },
      });
      await tx.teamInvite.update({ where: { id: invite.id }, data: { usedById: user.id } });
      return user.id;
    });
    await recordTeamEvent({
      kind: "team.access_reset_completed",
      message: `${invite.email} a retrouvé son accès (lien de réinitialisation) ${who.googleSub ? "avec Google" : "avec un nouveau mot de passe"}.`,
      actorId: userId,
      data: { inviteId: invite.id, invitedById: invite.invitedById, method: who.googleSub ? "google" : "password" },
    });
    return { ok: true, userId };
  } catch (err) {
    if (err instanceof JoinRefused) return refusal(err.code);
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return refusal("google_taken");
    if (isSerializationConflict(err)) return refusal("conflict");
    throw err;
  }
}

/**
 * Fills the profile's empty name / photo from Google (never overwrites what the member set). Only when
 * a Google account is first attached: later sign-ins leave the profile alone (a photo the member
 * removed stays removed).
 */
async function fillProfile(user: Pick<AdminUser, "id" | "name" | "avatarUrl">, identity: GoogleIdentity) {
  const data = { ...(!user.name && identity.name ? { name: identity.name } : {}), ...(!user.avatarUrl && identity.picture ? { avatarUrl: identity.picture } : {}) };
  if (Object.keys(data).length) await db.adminUser.update({ where: { id: user.id }, data });
}

export type GoogleSignInOutcome = { ok: true; userId: string; how: "signin" | "linked" | "joined" } | Refusal;

/**
 * « Continuer avec Google » (login or invitation): who the verified Google identity signs in as.
 *   1. the member with that Google account;
 *   2. the member with that e-mail and no Google account yet: linked (its other sessions end) — only
 *      when Google proves the address (a Gmail address, or a Workspace account of the e-mail's domain)
 *      or it comes with the invitation link; otherwise the member signs in with its password and
 *      links Google from Profil;
 *   3. an invitation (its link: `inviteId`) or, proven address only, a pending invitation /
 *      authorized e-mail for that address: joins the team;
 *   otherwise refused. Removed members are refused unless invited again. With `inviteId`, the Google
 *   e-mail must be the invited one.
 */
export async function resolveGoogleSignIn(identity: GoogleIdentity, inviteId?: string): Promise<GoogleSignInOutcome> {
  let invite: TeamInvite | null = null;
  if (inviteId) {
    invite = await db.teamInvite.findUnique({ where: { id: inviteId } });
    if (!invite || !invite.tokenHash || inviteStatus(invite) !== "pending") return refusal("invite_invalid");
    if (invite.email !== identity.email) return refusal("invite_mismatch");
  }
  const proven = googleProvesEmail(identity) || !!invite;

  const bySub = await db.adminUser.findUnique({ where: { googleSub: identity.sub } });
  if (bySub && !bySub.disabledAt) {
    if (bySub.googleEmail !== identity.email) await db.adminUser.update({ where: { id: bySub.id }, data: { googleEmail: identity.email } });
    return { ok: true, userId: bySub.id, how: "signin" };
  }
  // A removed member's Google account under another address can't come back through this one.
  if (bySub && bySub.email !== identity.email) return refusal("removed");

  const byEmail = bySub ?? (await db.adminUser.findUnique({ where: { email: identity.email } }));
  if (byEmail && !byEmail.disabledAt) {
    if (byEmail.googleSub && byEmail.googleSub !== identity.sub) return refusal("other_google");
    if (!proven) return refusal("unproven_email");
    if (invite?.reset) {
      // An access-reset link used with Google: that Google account becomes the member's way in.
      const reset = await completeAccessReset(invite, { googleSub: identity.sub, googleEmail: identity.email });
      if (!reset.ok) return reset;
      await fillProfile(byEmail, identity);
      return { ok: true, userId: byEmail.id, how: "linked" };
    }
    if (invite) {
      // Through the invitation's link (maybe the only proof of the address): the link is used up, and
      // its access added, in the same transaction as the Google account is attached.
      const accepted = await acceptInviteForMember(invite, byEmail.id, { googleSub: identity.sub, googleEmail: identity.email });
      if (!accepted.ok) return accepted;
      await fillProfile(byEmail, identity);
      await recordTeamEvent({
        kind: "team.invite_accepted",
        message: `${byEmail.email} a accepté une invitation (${ROLE_LABELS[accepted.role]}) et lié son compte Google.`,
        actorId: byEmail.id,
        data: { inviteId: invite.id, role: accepted.role, from: accepted.from, method: "google" },
      });
      return { ok: true, userId: byEmail.id, how: "linked" };
    }
    try {
      await db.adminUser.update({ where: { id: byEmail.id }, data: { googleSub: identity.sub, googleEmail: identity.email, sessionVersion: { increment: 1 } } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return refusal("google_taken");
      throw err;
    }
    await fillProfile(byEmail, identity);
    await recordTeamEvent({ kind: "team.google_linked", message: `${byEmail.email} a lié son compte Google (même e-mail).`, actorId: byEmail.id });
    return { ok: true, userId: byEmail.id, how: "linked" };
  }

  if (!invite) {
    // Without the link, only an address Google proves may use an entry made for it.
    const found = await pendingInviteForEmail(identity.email);
    if (found && !proven) return refusal("unproven_join");
    invite = found;
  }
  if (!invite) return refusal(byEmail ? "removed" : "not_authorized");
  const joined = await joinFromInvite(invite, { email: identity.email, googleSub: identity.sub, googleEmail: identity.email, name: identity.name, avatarUrl: identity.picture });
  return joined.ok ? { ok: true, userId: joined.userId, how: "joined" } : joined;
}

/**
 * « Lier mon compte Google » from the profile (already re-authenticated at the start: current
 * password, or a fresh Google re-authentication): attaches the Google account to the signed-in
 * member and ends its other sessions (the caller signs this device back in).
 */
export async function linkGoogleAccount(user: Pick<SessionUser, "id" | "email">, identity: GoogleIdentity): Promise<{ ok: true; changed: boolean } | Refusal> {
  const other = await db.adminUser.findUnique({ where: { googleSub: identity.sub }, select: { id: true } });
  if (other && other.id !== user.id) return refusal("google_taken");
  const me = await db.adminUser.findUnique({ where: { id: user.id }, select: { id: true, name: true, avatarUrl: true, googleSub: true, googleEmail: true } });
  if (!me) return refusal("session");
  if (me.googleSub === identity.sub) {
    if (me.googleEmail !== identity.email) await db.adminUser.update({ where: { id: user.id }, data: { googleEmail: identity.email } });
    return { ok: true, changed: false };
  }
  try {
    await db.adminUser.update({ where: { id: user.id }, data: { googleSub: identity.sub, googleEmail: identity.email, sessionVersion: { increment: 1 } } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return refusal("google_taken");
    throw err;
  }
  // A first Google account only: replacing one leaves the profile as the member set it.
  if (!me.googleSub) await fillProfile(me, identity);
  await recordTeamEvent({
    kind: "team.google_linked",
    message: `${user.email} a lié le compte Google ${identity.email}${me.googleSub ? " (à la place du précédent)" : ""}.`,
    actorId: user.id,
    data: { googleEmail: identity.email },
  });
  return { ok: true, changed: true };
}

/**
 * The end of a « reauth » round trip: the signed-in member's own Google account, signed in at
 * Google moments ago (`auth_time`), stamps `reauthAt` — a Google-only account may then set its first
 * password (or link another Google account) for GOOGLE_REAUTH_MAX_AGE_MS. Refusals are Profil codes.
 */
export async function recordGoogleReauth(userId: string, identity: GoogleIdentity, now = new Date()): Promise<{ ok: true } | { ok: false; code: "reauth_other_account" | "reauth_not_fresh" }> {
  const me = await db.adminUser.findUnique({ where: { id: userId }, select: { googleSub: true } });
  if (!me?.googleSub || me.googleSub !== identity.sub) return { ok: false, code: "reauth_other_account" };
  if (!freshGoogleAuth(identity, now.getTime())) return { ok: false, code: "reauth_not_fresh" };
  await db.adminUser.update({ where: { id: userId }, data: { reauthAt: now } });
  return { ok: true };
}

/** Where a member lands after signing in: `next` when given (already checked safe), its only store directly, else the store list. */
export async function landingPath(userId: string, next?: string | null): Promise<string> {
  if (next) return next;
  const user = await db.adminUser.findUnique({ where: { id: userId }, select: { id: true, allStores: true } });
  const stores = user ? await db.store.findMany({ where: accessibleStoreWhere(user), select: { id: true }, take: 2 }) : [];
  return stores.length === 1 ? `/dashboard/stores/${stores[0].id}` : "/dashboard";
}
