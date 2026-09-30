"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { UserRole, type Prisma, type TeamInvite } from "@prisma/client";
import { bumpSessionVersion, logout, signIn, type SessionUser } from "@/lib/auth";
import { canGrantRole, canManageMember, recordTeamEvent, requireRole as requireRoleOrRefuse, roleAtLeast, ROLE_LABELS, wouldRemoveLastOwner } from "@/lib/access";
import { db } from "@/lib/db";
import { flashUrl } from "@/lib/flash";
import { googleAuthConfigured } from "@/lib/google-auth";
import { log } from "@/lib/log";
import { escapeHtml, operatorMailer, sendOperatorEmail } from "@/lib/notify";
import { rateLimit } from "@/lib/ratelimit";
import { canGrantAccess, EMAIL_RE, INVITE_TTL_MS, inviteUrl, isSerializationConflict, newInviteToken, revokeUngrantableInvites, serializableTx } from "@/lib/team";
import { isGmailAddress, loginUrl, TEAM_FLASH, type TeamErrorCode, type TeamOkCode } from "@/lib/team-rules";

/*
 * Équipe (admins and owners): members' role / stores / removal / access reset, invitations (token link
 * by e-mail) and authorized e-mails (Google sign-in without a link). Guards: admins never grant or
 * touch the owner role; nobody grants stores outside their own scope, nor changes / removes a member
 * who sees stores outside it; the last active owner can't be demoted or removed. The acting member
 * is read again (role, stores, still active) where the change is made — inside the transaction for
 * changes to members — never trusted from its session. A member removed, demoted or narrowed loses
 * the pending invitations it can no longer grant. Every change is journaled (team.*). Outcomes come
 * back as codes (`?ok=` / `?error=`, fixed texts in TEAM_FLASH).
 */

const TEAM = "/dashboard/team";

/** Invitation e-mails (invite, resend, access reset) per member: 20 per hour. */
const TEAM_INVITE_LIMIT = { limit: 20, windowMs: 60 * 60_000 } as const;

/** Équipe is for admins and owners (a viewer is sent back to /dashboard with `team_only`). */
const requireRole = (min: "admin") => requireRoleOrRefuse(min, "team_only");

function back(params: { ok?: TeamOkCode; error?: TeamErrorCode; form?: string } = {}): never {
  redirect(flashUrl(TEAM, params));
}

const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();

const ROLES = Object.values(UserRole);
function parseRole(value: string): UserRole | null {
  return (ROLES as string[]).includes(value) ? (value as UserRole) : null;
}

type Client = Prisma.TransactionClient | typeof db;

/** The acting member as it is now: its role, and the stores it may hand out (null: every store). */
type Actor = { id: string; email: string; name: string | null; role: UserRole; allStores: boolean; scope: Map<string, string> | null };

/**
 * The acting member read again through `client` (inside the transaction for member changes): null
 * when it was removed or is no longer an admin / owner meanwhile.
 */
async function actorNow(client: Client, id: string): Promise<Actor | null> {
  const u = await client.adminUser.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, role: true, allStores: true, disabledAt: true, storeAccess: { select: { storeId: true } } },
  });
  if (!u || u.disabledAt || !roleAtLeast(u.role, "admin")) return null;
  const all = u.allStores || u.role === "owner";
  const scope = all ? null : new Map((await client.store.findMany({ where: { id: { in: u.storeAccess.map((a) => a.storeId) } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
  return { id: u.id, email: u.email, name: u.name, role: u.role, allStores: all, scope };
}

/**
 * The access a form asks for (`allStores` switch + `storeIds` checkboxes), limited to what `actor` may
 * grant: « toutes les boutiques » only from someone who has them all.
 */
function parseAccess(fd: FormData, actor: Actor, role: UserRole): { allStores: boolean; storeIds: string[] } | { error: TeamErrorCode } {
  // Owners see everything.
  if (role === "owner") return { allStores: true, storeIds: [] };
  const allStores = fd.get("allStores") === "on";
  if (allStores && actor.scope) return { error: "stores_outside_scope" };
  if (allStores) return { allStores: true, storeIds: [] };
  // A member limited to some stores, none of which exists (any more): nothing it could share.
  if (actor.scope && actor.scope.size === 0) return { error: "no_store_to_share" };
  const requested = [...new Set(fd.getAll("storeIds").map(String))];
  if (actor.scope && requested.some((id) => !actor.scope!.has(id))) return { error: "stores_outside_scope" };
  if (!requested.length) return { error: "stores_none" };
  return { allStores: false, storeIds: requested };
}

async function accessLabel(access: { allStores: boolean; storeIds: string[] }): Promise<string> {
  if (access.allStores) return "toutes les boutiques";
  const names = (await db.store.findMany({ where: { id: { in: access.storeIds } }, select: { name: true } })).map((s) => `« ${s.name} »`);
  return names.join(", ") || "aucune boutique";
}

/**
 * `actor` may resend / revoke / replace `invite`: it could have created it (role it may grant, stores
 * in its scope — a store deleted since doesn't count).
 */
async function canHandleInvite(actor: Actor, invite: TeamInvite): Promise<boolean> {
  if (!canGrantRole(actor.role, invite.role)) return false;
  if (!actor.scope) return true;
  const live = (await db.store.findMany({ where: { id: { in: invite.storeIds } }, select: { id: true } })).map((s) => s.id);
  return canGrantAccess({ role: actor.role, allStores: false, storeIds: [...actor.scope.keys()] }, { role: invite.role, allStores: invite.allStores, storeIds: live });
}

/**
 * `actor` may change or remove `target` as far as stores go: an actor limited to some stores only
 * acts on members whose access is within them (never on one that sees every store).
 */
function targetInScope(actor: Actor, target: { role: UserRole; allStores: boolean; storeAccess: { storeId: string }[] }): boolean {
  if (!actor.scope) return true;
  if (target.allStores || target.role === "owner") return false;
  return target.storeAccess.every((a) => actor.scope!.has(a.storeId));
}

async function activeMemberWithEmail(email: string) {
  return db.adminUser.findFirst({ where: { email, disabledAt: null }, select: { id: true } });
}

/** A serialization conflict that survived the retries: « Modification simultanée ». */
const conflictToError = (err: unknown): { error: TeamErrorCode } => {
  if (isSerializationConflict(err)) return { error: "conflict" };
  throw err;
};

/** Signs `userId` out everywhere; when it is the actor, signs this device back in. */
async function signOutMember(userId: string, actorId: string) {
  await bumpSessionVersion(userId);
  if (userId === actorId) await signIn(actorId);
}

/** Another invitation e-mail may go out from `actorId` (TEAM_INVITE_LIMIT). */
async function inviteAllowed(actorId: string): Promise<boolean> {
  return rateLimit(`team-invite:${actorId}`, TEAM_INVITE_LIMIT.limit, TEAM_INVITE_LIMIT.windowMs);
}

/* ------------------------------------------------------------------ */
/* Members                                                             */
/* ------------------------------------------------------------------ */

export async function updateMemberRoleAction(fd: FormData) {
  const actor = await requireRole("admin");
  const role = parseRole(str(fd, "role"));
  if (!role) back({ error: "role_unknown" });
  const memberId = str(fd, "memberId");
  // The actor and the target are read inside the transaction (a concurrent change can't slip through).
  const outcome = await serializableTx(async (tx): Promise<{ error: TeamErrorCode } | { same: true } | { target: { id: string; email: string; role: UserRole } }> => {
    const me = await actorNow(tx, actor.id);
    if (!me) return { error: "actor_changed" };
    if (!canGrantRole(me.role, role)) return { error: "grant_owner" };
    const target = await tx.adminUser.findUnique({ where: { id: memberId }, include: { storeAccess: { select: { storeId: true } } } });
    if (!target || target.disabledAt) return { error: "member_not_found" };
    if (target.role === role) return { same: true };
    if (!canManageMember(me, target)) return { error: "manage_owner" };
    if (!targetInScope(me, target)) return { error: "out_of_scope" };
    const members = await tx.adminUser.findMany({ select: { id: true, role: true, disabledAt: true } });
    if (wouldRemoveLastOwner(members, target.id, { role })) return { error: "last_owner_demote" };
    await tx.adminUser.update({ where: { id: target.id }, data: { role, ...(role === "owner" ? { allStores: true } : {}) } });
    // Invitations it sent that its new role can't grant any more.
    await revokeUngrantableInvites(tx, target.id);
    return { target: { id: target.id, email: target.email, role: target.role } };
  }).catch(conflictToError);
  if ("error" in outcome) back({ error: outcome.error });
  if ("same" in outcome) back({ ok: "role_unchanged" });
  const { target } = outcome;
  // Open sessions pick up the new role on their next request; signed out so the change is felt at once.
  await signOutMember(target.id, actor.id);
  await recordTeamEvent({
    kind: "team.role_changed",
    message: `${actor.email} a changé le rôle de ${target.email} : ${ROLE_LABELS[target.role]} → ${ROLE_LABELS[role]}.`,
    actorId: actor.id,
    data: { userId: target.id, from: target.role, to: role },
  });
  revalidatePath(TEAM);
  if (target.id === actor.id) {
    // Demoted itself below admin: Équipe is closed to it now.
    if (!roleAtLeast(role, "admin")) redirect(flashUrl("/dashboard", { ok: "self_viewer" }));
    back({ ok: "self_role_changed" });
  }
  back({ ok: "role_changed" });
}

/**
 * A member's stores: read and changed in one serializable transaction (like a role change), so a
 * concurrent change of the member (role, removal, stores) can't slip between the checks and the write.
 */
export async function updateMemberAccessAction(fd: FormData) {
  const actor = await requireRole("admin");
  const memberId = str(fd, "memberId");
  const outcome = await serializableTx(async (tx): Promise<{ error: TeamErrorCode } | { target: { id: string; email: string }; allStores: boolean; storeIds: string[] }> => {
    const me = await actorNow(tx, actor.id);
    if (!me) return { error: "actor_changed" };
    const target = await tx.adminUser.findUnique({ where: { id: memberId }, include: { storeAccess: { select: { storeId: true } } } });
    if (!target || target.disabledAt) return { error: "member_not_found" };
    if (!canManageMember(me, target)) return { error: "manage_owner" };
    if (target.role === "owner") return { error: "owner_all_stores" };
    // A member who sees stores the actor doesn't can't be narrowed by it (it would drop stores it can't see).
    if (me.scope && target.allStores) return { error: "narrow_all_stores" };
    const access = parseAccess(fd, me, target.role);
    if ("error" in access) return access;
    // A limited actor only changes the stores it can see; the member keeps its other ones.
    const kept = me.scope ? target.storeAccess.map((a) => a.storeId).filter((id) => !me.scope!.has(id)) : [];
    const storeIds = access.allStores ? [] : [...new Set([...kept, ...access.storeIds])];
    await tx.adminUser.update({ where: { id: target.id }, data: { allStores: access.allStores } });
    await tx.storeAccess.deleteMany({ where: { userId: target.id } });
    if (storeIds.length) await tx.storeAccess.createMany({ data: storeIds.map((storeId) => ({ userId: target.id, storeId })), skipDuplicates: true });
    // Invitations it sent for stores it no longer sees.
    await revokeUngrantableInvites(tx, target.id);
    return { target: { id: target.id, email: target.email }, allStores: access.allStores, storeIds };
  }).catch(conflictToError);
  if ("error" in outcome) back({ error: outcome.error });
  const { target, allStores, storeIds } = outcome;
  const label = await accessLabel({ allStores, storeIds });
  await recordTeamEvent({
    kind: "team.access_changed",
    message: `${actor.email} a changé l'accès de ${target.email} : ${label}.`,
    actorId: actor.id,
    data: { userId: target.id, allStores, storeIds },
  });
  revalidatePath(TEAM);
  back({ ok: "access_changed" });
}

/**
 * Removes a member: disabled (rows kept for the journal), signed out everywhere, its password and
 * Google account detached (coming back through a new invitation sets new ones), and every pending
 * entry tied to it revoked — for its e-mail, the ones it joined through (whatever its e-mail became)
 * and the ones it sent.
 */
export async function removeMemberAction(fd: FormData) {
  const actor = await requireRole("admin");
  const memberId = str(fd, "memberId");
  const outcome = await serializableTx(async (tx): Promise<{ error: TeamErrorCode } | { target: { id: string; email: string; role: UserRole } }> => {
    const me = await actorNow(tx, actor.id);
    if (!me) return { error: "actor_changed" };
    const target = await tx.adminUser.findUnique({ where: { id: memberId }, include: { storeAccess: { select: { storeId: true } } } });
    if (!target || target.disabledAt) return { error: "member_not_found" };
    if (!canManageMember(me, target)) return { error: "remove_owner" };
    if (!targetInScope(me, target)) return { error: "out_of_scope" };
    const members = await tx.adminUser.findMany({ select: { id: true, role: true, disabledAt: true } });
    if (wouldRemoveLastOwner(members, target.id, { disable: true })) return { error: "last_owner_remove" };
    const now = new Date();
    await tx.adminUser.update({
      where: { id: target.id },
      data: {
        disabledAt: now,
        sessionVersion: { increment: 1 },
        passwordHash: null,
        googleSub: null,
        googleEmail: null,
        reauthAt: null,
        pendingEmail: null,
        pendingEmailTokenHash: null,
        pendingEmailExpiresAt: null,
      },
    });
    await tx.teamInvite.updateMany({
      where: { revokedAt: null, acceptedAt: null, OR: [{ email: target.email }, { usedById: target.id }, { invitedById: target.id }] },
      data: { revokedAt: now },
    });
    return { target: { id: target.id, email: target.email, role: target.role } };
  }).catch(conflictToError);
  if ("error" in outcome) back({ error: outcome.error });
  const { target } = outcome;
  await recordTeamEvent({
    kind: "team.member_removed",
    message: `${actor.email} a retiré ${target.email} de l'équipe.`,
    actorId: actor.id,
    data: { userId: target.id, role: target.role },
  });
  if (target.id === actor.id) {
    // Removed itself: signed out, told why on the sign-in page.
    await logout();
    redirect(loginUrl("removed"));
  }
  revalidatePath(TEAM);
  back({ ok: "member_removed" });
}

/**
 * « Réinitialiser l'accès » (forgotten password, lost Google account): the member's password and
 * Google account are cleared and every session ends, and a fresh invitation link marked `reset` is
 * made for its address (its previous pending links die) — e-mailed when possible, shown once. Using
 * it only sets a new way in (password or Google), never another role or stores (completeAccessReset).
 * For a member the actor may manage, never itself (Profil is for that).
 */
export async function resetMemberAccessAction(_prev: InviteState, fd: FormData): Promise<InviteState> {
  const actor = await requireRole("admin");
  const memberId = str(fd, "memberId");
  const refuse = (code: TeamErrorCode): InviteState => ({ error: TEAM_FLASH.error[code] });
  if (memberId === actor.id) return refuse("reset_self");
  if (!(await inviteAllowed(actor.id))) return refuse("invite_rate");
  const { token, tokenHash } = newInviteToken();
  const outcome = await serializableTx(
    async (tx): Promise<{ error: TeamErrorCode } | { me: Actor; target: { id: string; email: string; role: UserRole }; access: { allStores: boolean; storeIds: string[] } }> => {
      const me = await actorNow(tx, actor.id);
      if (!me) return { error: "actor_changed" };
      const target = await tx.adminUser.findUnique({ where: { id: memberId }, include: { storeAccess: { select: { storeId: true } } } });
      if (!target || target.disabledAt) return { error: "member_not_found" };
      if (target.id === me.id) return { error: "reset_self" };
      if (!canManageMember(me, target)) return { error: "manage_owner" };
      if (!targetInScope(me, target)) return { error: "out_of_scope" };
      const now = new Date();
      await tx.adminUser.update({
        where: { id: target.id },
        data: {
          passwordHash: null,
          googleSub: null,
          googleEmail: null,
          reauthAt: null,
          pendingEmail: null,
          pendingEmailTokenHash: null,
          pendingEmailExpiresAt: null,
          sessionVersion: { increment: 1 },
        },
      });
      // One live link per address: the previous ones stop working.
      await tx.teamInvite.updateMany({ where: { email: target.email, tokenHash: { not: null }, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });
      const access = { allStores: target.allStores || target.role === "owner", storeIds: target.allStores || target.role === "owner" ? [] : target.storeAccess.map((a) => a.storeId) };
      await tx.teamInvite.create({
        data: { email: target.email, role: target.role, ...access, tokenHash, reset: true, invitedById: me.id, expiresAt: new Date(now.getTime() + INVITE_TTL_MS) },
      });
      return { me, target: { id: target.id, email: target.email, role: target.role }, access };
    },
  ).catch(conflictToError);
  if ("error" in outcome) return refuse(outcome.error);
  const { me, target, access } = outcome;
  await recordTeamEvent({
    kind: "team.access_reset",
    message: `${actor.email} a réinitialisé l'accès de ${target.email} (mot de passe et compte Google retirés, nouveau lien envoyé).`,
    actorId: actor.id,
    data: { userId: target.id, role: target.role },
  });
  const link = inviteUrl(token);
  const sent = await mailInvite(me, { email: target.email, role: target.role, reset: true }, link, await accessLabel(access));
  revalidatePath(TEAM);
  return { ...resetNote(sent, target.email), link };
}

/* ------------------------------------------------------------------ */
/* Invitations                                                         */
/* ------------------------------------------------------------------ */

export type InviteState = { ok?: string; error?: string; warning?: string; link?: string; email?: string };

/** Sends the invitation (or access-reset) e-mail when an operator mailer is configured. Never throws. */
async function mailInvite(actor: Pick<Actor, "name" | "email">, invite: { email: string; role: UserRole; reset?: boolean }, link: string, stores: string): Promise<"sent" | "off" | "failed"> {
  if (!(await operatorMailer().catch(() => null))) return "off";
  const inviter = actor.name ? `${actor.name} (${actor.email})` : actor.email;
  const role = ROLE_LABELS[invite.role];
  const mail = invite.reset
    ? {
        subject: "Votre accès à Whop Checkout a été réinitialisé",
        text: `${inviter} a réinitialisé votre accès à Whop Checkout (${role}, ${stores}) : votre ancien mot de passe ne fonctionne plus.\n\nChoisir un nouveau mot de passe (ou vous connecter avec Google) : ${link}\n\nCe lien est personnel et expire dans 7 jours.`,
        html: `<p>${escapeHtml(inviter)} a réinitialisé votre accès à <strong>Whop Checkout</strong> (${escapeHtml(role)}, ${escapeHtml(stores)}) : votre ancien mot de passe ne fonctionne plus.</p><p><a href="${escapeHtml(link)}">Choisir un nouveau mot de passe</a> (ou vous connecter avec Google)</p><p style="color:#71717a;font-size:13px">Ce lien est personnel et expire dans 7 jours. Si vous n'avez rien demandé, prévenez le propriétaire du compte.</p>`,
      }
    : {
        subject: `${actor.name ?? actor.email} vous invite sur Whop Checkout`,
        text: `${inviter} vous invite à rejoindre son équipe sur Whop Checkout, en tant que ${role} (${stores}).\n\nAccepter l'invitation : ${link}\n\nCe lien est personnel et expire dans 7 jours.`,
        html: `<p>${escapeHtml(inviter)} vous invite à rejoindre son équipe sur <strong>Whop Checkout</strong>, en tant que <strong>${escapeHtml(role)}</strong> (${escapeHtml(stores)}).</p><p><a href="${escapeHtml(link)}">Accepter l'invitation</a></p><p style="color:#71717a;font-size:13px">Ce lien est personnel et expire dans 7 jours. Si vous n'attendiez pas cette invitation, ignorez cet e-mail.</p>`,
      };
  try {
    return (await sendOperatorEmail({ to: invite.email, ...mail })) ? "sent" : "off";
  } catch (err) {
    log.warn("team.invite_email_failed", "Invitation e-mail not sent", { err });
    return "failed";
  }
}

function sentNote(sent: "sent" | "off" | "failed", email: string): Pick<InviteState, "ok" | "warning"> {
  if (sent === "sent") return { ok: `Invitation envoyée à ${email}. Vous pouvez aussi copier le lien ci-dessous.` };
  if (sent === "failed") return { ok: `Invitation créée pour ${email}.`, warning: "L'e-mail n'a pas pu partir : copiez le lien ci-dessous et envoyez-le vous-même." };
  return { ok: `Invitation créée pour ${email}.`, warning: "Aucun envoi d'e-mail configuré : copiez le lien ci-dessous et envoyez-le vous-même." };
}

function resetNote(sent: "sent" | "off" | "failed", email: string): Pick<InviteState, "ok" | "warning"> {
  const done = `Accès de ${email} réinitialisé : ses sessions sont fermées, son mot de passe et son compte Google retirés.`;
  if (sent === "sent") return { ok: `${done} Lien envoyé par e-mail ; vous pouvez aussi le copier ci-dessous.` };
  return { ok: done, warning: sent === "failed" ? "L'e-mail n'a pas pu partir : copiez le lien ci-dessous et envoyez-le vous-même." : "Aucun envoi d'e-mail configuré : copiez le lien ci-dessous et envoyez-le vous-même." };
}

/** The acting member as it is now, for the invitation actions (null: removed or no longer admin meanwhile). */
async function currentActor(actor: SessionUser): Promise<Actor | null> {
  return actorNow(db, actor.id);
}

/** Used with useActionState: the link (raw token) is returned once, never stored. */
export async function createInviteAction(_prev: InviteState, fd: FormData): Promise<InviteState> {
  const session = await requireRole("admin");
  const email = str(fd, "email").toLowerCase().slice(0, 200);
  const refuse = (code: TeamErrorCode): InviteState => ({ error: TEAM_FLASH.error[code], email });
  const actor = await currentActor(session);
  if (!actor) return refuse("actor_changed");
  if (!EMAIL_RE.test(email)) return refuse("email_invalid");
  const role = parseRole(str(fd, "role"));
  if (!role) return refuse("role_unknown");
  if (!canGrantRole(actor.role, role)) return { error: "Seul un propriétaire peut inviter un propriétaire.", email };
  // An active member's access is reset from its row (« Réinitialiser l'accès »), never re-invited.
  if (await activeMemberWithEmail(email)) return { error: `${email} fait déjà partie de l'équipe.`, email };
  const access = parseAccess(fd, actor, role);
  if ("error" in access) return refuse(access.error);
  if (!(await inviteAllowed(actor.id))) return refuse("invite_rate");
  const { token, tokenHash } = newInviteToken();
  const now = new Date();
  // A new invitation replaces the previous links for that address — those this member could have
  // sent itself (another member's invitation with more access stays; the newest pending one is used).
  const previous = await db.teamInvite.findMany({ where: { email, tokenHash: { not: null }, acceptedAt: null, revokedAt: null } });
  const replaced: string[] = [];
  for (const p of previous) if (await canHandleInvite(actor, p)) replaced.push(p.id);
  await db.$transaction([
    db.teamInvite.updateMany({ where: { id: { in: replaced }, revokedAt: null }, data: { revokedAt: now } }),
    db.teamInvite.create({ data: { email, role, allStores: access.allStores, storeIds: access.storeIds, tokenHash, invitedById: actor.id, expiresAt: new Date(now.getTime() + INVITE_TTL_MS) } }),
  ]);
  const stores = await accessLabel(access);
  await recordTeamEvent({
    kind: "team.invite_created",
    message: `${actor.email} a invité ${email} (${ROLE_LABELS[role]}, ${stores}).`,
    actorId: actor.id,
    data: { email, role, allStores: access.allStores, storeIds: access.storeIds },
  });
  const link = inviteUrl(token);
  const sent = await mailInvite(actor, { email, role }, link, stores);
  revalidatePath(TEAM);
  return { ...sentNote(sent, email), link };
}

/**
 * A new link (new token, 7 more days) for a pending or expired invitation; the old link stops
 * working. An access-reset link is renewed for its (still active) member.
 */
export async function resendInviteAction(_prev: InviteState, fd: FormData): Promise<InviteState> {
  const session = await requireRole("admin");
  const actor = await currentActor(session);
  if (!actor) return { error: TEAM_FLASH.error.actor_changed };
  const invite = await db.teamInvite.findUnique({ where: { id: str(fd, "inviteId") } });
  if (!invite?.tokenHash || invite.acceptedAt || invite.revokedAt) return { error: TEAM_FLASH.error.invite_not_found };
  if (!(await canHandleInvite(actor, invite))) return { error: TEAM_FLASH.error.invite_not_yours };
  const member = await activeMemberWithEmail(invite.email);
  if (!invite.reset && member) return { error: `${invite.email} fait déjà partie de l'équipe.` };
  if (invite.reset && !member) return { error: TEAM_FLASH.error.invite_not_found };
  if (!(await inviteAllowed(actor.id))) return { error: TEAM_FLASH.error.invite_rate };
  const { token, tokenHash } = newInviteToken();
  const updated = await db.teamInvite.updateMany({
    where: { id: invite.id, acceptedAt: null, revokedAt: null },
    data: { tokenHash, expiresAt: new Date(Date.now() + INVITE_TTL_MS), invitedById: actor.id },
  });
  if (!updated.count) return { error: TEAM_FLASH.error.invite_not_found };
  await recordTeamEvent({
    kind: "team.invite_resent",
    message: `${actor.email} a renvoyé ${invite.reset ? "le lien de réinitialisation" : "l'invitation"} de ${invite.email}.`,
    actorId: actor.id,
    data: { inviteId: invite.id, email: invite.email, reset: invite.reset },
  });
  const link = inviteUrl(token);
  const sent = await mailInvite(actor, invite, link, await accessLabel(invite));
  revalidatePath(TEAM);
  return { ...sentNote(sent, invite.email), link };
}

export async function revokeInviteAction(fd: FormData) {
  const session = await requireRole("admin");
  const actor = await currentActor(session);
  if (!actor) back({ error: "actor_changed" });
  const invite = await db.teamInvite.findUnique({ where: { id: str(fd, "inviteId") } });
  if (!invite?.tokenHash || invite.revokedAt || invite.acceptedAt) back({ error: "invite_not_found" });
  if (!(await canHandleInvite(actor, invite))) back({ error: "invite_not_yours" });
  await db.teamInvite.update({ where: { id: invite.id }, data: { revokedAt: new Date() } });
  await recordTeamEvent({ kind: "team.invite_revoked", message: `${actor.email} a révoqué l'invitation de ${invite.email}.`, actorId: actor.id, data: { inviteId: invite.id, email: invite.email } });
  revalidatePath(TEAM);
  back({ ok: "invite_revoked" });
}

/* ------------------------------------------------------------------ */
/* Authorized e-mails                                                  */
/* ------------------------------------------------------------------ */

export async function addAuthorizedEmailAction(fd: FormData) {
  const session = await requireRole("admin");
  const email = str(fd, "email").toLowerCase().slice(0, 200);
  const form = "E-mails autorisés";
  const actor = await currentActor(session);
  if (!actor) back({ error: "actor_changed", form });
  if (!EMAIL_RE.test(email)) back({ error: "email_invalid", form });
  const role = parseRole(str(fd, "role"));
  if (!role) back({ error: "role_unknown", form });
  if (!canGrantRole(actor.role, role)) back({ error: "authorize_owner", form });
  if (await activeMemberWithEmail(email)) back({ error: "already_member", form });
  if (await db.teamInvite.findFirst({ where: { email, tokenHash: null, revokedAt: null }, select: { id: true } })) back({ error: "already_authorized", form });
  const access = parseAccess(fd, actor, role);
  if ("error" in access) back({ error: access.error, form });
  await db.teamInvite.create({ data: { email, role, allStores: access.allStores, storeIds: access.storeIds, invitedById: actor.id } });
  const stores = await accessLabel(access);
  await recordTeamEvent({
    kind: "team.email_authorized",
    message: `${actor.email} a autorisé ${email} (${ROLE_LABELS[role]}, ${stores}) à se connecter avec Google.`,
    actorId: actor.id,
    data: { email, role, allStores: access.allStores, storeIds: access.storeIds },
  });
  revalidatePath(TEAM);
  // Only a Gmail address is proven by Google on its own: another one works only as a Workspace
  // account of its domain. Google sign-in not set up yet: it will only work once it is.
  back({ ok: !isGmailAddress(email) ? "email_authorized_workspace" : googleAuthConfigured() ? "email_authorized" : "email_authorized_google_off" });
}

export async function removeAuthorizedEmailAction(fd: FormData) {
  const session = await requireRole("admin");
  const actor = await currentActor(session);
  if (!actor) back({ error: "actor_changed" });
  const entry = await db.teamInvite.findUnique({ where: { id: str(fd, "inviteId") } });
  if (!entry || entry.tokenHash || entry.revokedAt) back({ error: "authorized_not_found" });
  if (!(await canHandleInvite(actor, entry))) back({ error: "authorized_not_yours" });
  await db.teamInvite.update({ where: { id: entry.id }, data: { revokedAt: new Date() } });
  await recordTeamEvent({ kind: "team.email_unauthorized", message: `${actor.email} a retiré ${entry.email} des e-mails autorisés.`, actorId: actor.id, data: { inviteId: entry.id, email: entry.email } });
  revalidatePath(TEAM);
  back({ ok: "email_unauthorized" });
}
