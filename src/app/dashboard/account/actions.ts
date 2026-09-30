"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { accountPasswordAllowed, bumpSessionVersion, hashPassword, requireUser, signIn } from "@/lib/auth";
import { recordTeamEvent } from "@/lib/access";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { flashUrl } from "@/lib/flash";
import { GOOGLE_REAUTH_MAX_AGE_MS } from "@/lib/google-auth";
import { log } from "@/lib/log";
import { escapeHtml, operatorMailer, sendOperatorEmail } from "@/lib/notify";
import { EMAIL_RE, hashInviteToken, newInviteToken, pendingInviteForEmail } from "@/lib/team";
import { passwordProblemCode, type AccountErrorCode, type AccountOkCode } from "@/lib/team-rules";

/*
 * Profil: the signed-in member's own name, e-mail, password, Google link and sessions. Every
 * outcome comes back as a code (`?ok=` / `?error=`, fixed texts in ACCOUNT_FLASH); `form=` names the
 * form whose typed values are restored.
 */

const ACCOUNT = "/dashboard/account";
/** How long the link confirming a new e-mail works. */
const EMAIL_CHANGE_TTL_MS = 60 * 60_000;

function back(params: { ok?: AccountOkCode; error?: AccountErrorCode; form?: string } = {}, hash = ""): never {
  redirect(flashUrl(ACCOUNT, params, hash));
}

const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();

/** The member's current password is right (rate limited per member: 10 per 15 minutes). */
async function passwordMatches(userId: string, password: string): Promise<boolean> {
  if (!(await accountPasswordAllowed(userId))) back({ error: "rate" });
  const row = await db.adminUser.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  return !!row?.passwordHash && !!password && (await bcrypt.compare(password, row.passwordHash));
}

/**
 * A security notice to the member's address (when an e-mail sender is configured): its e-mail or
 * password just changed — if it wasn't them, they know. Never throws, never blocks the change.
 */
async function securityNotice(to: string, subject: string, what: string) {
  try {
    if (!(await operatorMailer().catch(() => null))) return;
    const text = `${what}\n\nSi c'était vous, rien à faire. Sinon, contactez tout de suite le propriétaire du compte pour sécuriser votre accès à Whop Checkout.`;
    const html = `<p>${escapeHtml(what)}</p><p style="color:#71717a;font-size:13px">Si c'était vous, rien à faire. Sinon, contactez tout de suite le propriétaire du compte pour sécuriser votre accès à <strong>Whop Checkout</strong>.</p>`;
    await sendOperatorEmail({ to, subject, text, html });
  } catch (err) {
    log.warn("team.security_notice_failed", "Security notice not sent", { err });
  }
}

export async function updateProfileAction(fd: FormData) {
  const user = await requireUser();
  const name = str(fd, "name").replace(/\s+/g, " ").slice(0, 80) || null;
  await db.adminUser.update({ where: { id: user.id }, data: { name } });
  revalidatePath("/dashboard", "layout");
  back({ ok: "profile_saved" });
}

/** Removes the photo (the initial is shown instead; later Google sign-ins don't bring it back). */
export async function removeAvatarAction() {
  const user = await requireUser();
  await db.adminUser.update({ where: { id: user.id }, data: { avatarUrl: null } });
  revalidatePath("/dashboard", "layout");
  back({ ok: "avatar_removed" });
}

/* ------------------------------------------------------------------ */
/* E-mail                                                              */
/* ------------------------------------------------------------------ */

const taken = async (email: string, userId: string) => !!(await db.adminUser.findFirst({ where: { email, id: { not: userId } }, select: { id: true } }));

/**
 * A new sign-in e-mail, always confirmed with the current password; unique across the team.
 *   With an e-mail sender configured: the change waits for the link sent to the new address (1 hour).
 *   Without: changed at once — except to an address that has a pending invitation or authorized
 *   e-mail (it would take that entry's access over without proving it owns the address).
 */
export async function changeEmailAction(fd: FormData) {
  const user = await requireUser();
  const form = "E-mail";
  const email = str(fd, "email").toLowerCase().slice(0, 200);
  if (!EMAIL_RE.test(email)) back({ error: "email_invalid", form });
  if (email === user.email) back();
  if (!user.hasPassword) back({ error: "email_needs_password", form }, "#mot-de-passe");
  if (!(await passwordMatches(user.id, String(fd.get("currentPassword") ?? "")))) back({ error: "current_password", form });
  if (await taken(email, user.id)) back({ error: "email_taken", form });
  // An address with a pending invitation or authorized e-mail is never taken over, confirmed or not
  // (the entry's access would come with it).
  if (await pendingInviteForEmail(email)) back({ error: "email_pending_entry", form });

  if (await operatorMailer().catch(() => null)) {
    const { token, tokenHash } = newInviteToken();
    const link = `${env.appUrl}${ACCOUNT}/confirm-email/${token}`;
    let sent = false;
    try {
      sent = await sendOperatorEmail({
        to: email,
        subject: "Confirmez votre nouvel e-mail de connexion",
        text: `Pour utiliser cette adresse comme e-mail de connexion à Whop Checkout, ouvrez ce lien dans l'heure :\n\n${link}\n\nSi vous n'avez rien demandé, ignorez cet e-mail.`,
        html: `<p>Pour utiliser cette adresse comme e-mail de connexion à <strong>Whop Checkout</strong>, confirmez-la dans l'heure :</p><p><a href="${escapeHtml(link)}">Confirmer mon nouvel e-mail</a></p><p style="color:#71717a;font-size:13px">Si vous n'avez rien demandé, ignorez cet e-mail.</p>`,
      });
    } catch (err) {
      log.warn("team.email_change_mail_failed", "E-mail change confirmation not sent", { err });
    }
    if (!sent) back({ error: "email_mail_failed", form });
    await db.adminUser.update({
      where: { id: user.id },
      data: { pendingEmail: email, pendingEmailTokenHash: tokenHash, pendingEmailExpiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS) },
    });
    await recordTeamEvent({ kind: "team.email_change_requested", message: `${user.email} a demandé à changer son e-mail de connexion (confirmation envoyée).`, actorId: user.id });
    back({ ok: "email_confirm_sent" });
  }

  await applyEmailChange(user, email, form);
}

/**
 * The sign-in e-mail becomes `email`: every other session ends (this device is signed back in), and
 * the former address gets a notice when an e-mail sender is configured.
 */
async function applyEmailChange(user: { id: string; email: string }, email: string, form?: string): Promise<never> {
  try {
    await db.adminUser.update({
      where: { id: user.id },
      data: { email, pendingEmail: null, pendingEmailTokenHash: null, pendingEmailExpiresAt: null, sessionVersion: { increment: 1 } },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") back({ error: "email_taken", form });
    throw err;
  }
  await signIn(user.id);
  await recordTeamEvent({ kind: "team.email_changed", message: `${user.email} a changé son e-mail de connexion en ${email}.`, actorId: user.id, data: { from: user.email, to: email } });
  await securityNotice(
    user.email,
    "Votre e-mail de connexion a été changé",
    `L'e-mail de connexion de votre compte Whop Checkout est désormais ${email} : cette adresse-ci (${user.email}) ne permet plus de vous connecter.`,
  );
  revalidatePath("/dashboard", "layout");
  back({ ok: "email_changed" });
}

/** The link sent to the new address, opened while signed in as that member: the change is made. */
export async function confirmEmailChangeAction(fd: FormData) {
  const user = await requireUser();
  const token = String(fd.get("token") ?? "").slice(0, 200);
  const row = token ? await db.adminUser.findFirst({ where: { id: user.id, pendingEmailTokenHash: hashInviteToken(token) }, select: { pendingEmail: true, pendingEmailExpiresAt: true } }) : null;
  if (!row?.pendingEmail || !row.pendingEmailExpiresAt || row.pendingEmailExpiresAt <= new Date()) back({ error: "email_link_invalid" });
  // An entry created for that address since the request: not taken over either.
  if (await pendingInviteForEmail(row.pendingEmail)) back({ error: "email_pending_entry" });
  await applyEmailChange(user, row.pendingEmail);
}

export async function cancelEmailChangeAction() {
  const user = await requireUser();
  await db.adminUser.update({ where: { id: user.id }, data: { pendingEmail: null, pendingEmailTokenHash: null, pendingEmailExpiresAt: null } });
  back({ ok: "email_change_cancelled" });
}

/* ------------------------------------------------------------------ */
/* Password, Google, sessions                                          */
/* ------------------------------------------------------------------ */

const GOOGLE_OFF = { googleSub: null, googleEmail: null } as const;

/**
 * Sets or changes the password; every other device is signed out, and the member's address gets a
 * notice when an e-mail sender is configured. Changing it needs the current one; a Google-only
 * account's first password needs a fresh Google re-authentication (« Confirmer avec Google », used
 * once). `unlinkGoogle`: the Google account is detached at the same time.
 */
export async function setPasswordAction(fd: FormData) {
  const user = await requireUser();
  const form = "Mot de passe";
  const password = String(fd.get("password") ?? "");
  const unlink = fd.get("unlinkGoogle") === "on" && user.googleLinked;
  if (user.hasPassword && !(await passwordMatches(user.id, String(fd.get("currentPassword") ?? "")))) back({ error: "current_password", form });
  const problem = passwordProblemCode(password);
  if (problem) back({ error: problem, form });
  if (password !== String(fd.get("confirm") ?? "")) back({ error: "password_mismatch", form });
  const passwordHash = await hashPassword(password);
  const data = { passwordHash, reauthAt: null, sessionVersion: { increment: 1 }, ...(unlink ? GOOGLE_OFF : {}) };
  if (user.hasPassword) {
    await db.adminUser.update({ where: { id: user.id }, data });
  } else {
    // The re-authentication is checked and used up in the same write.
    const done = await db.adminUser.updateMany({ where: { id: user.id, passwordHash: null, reauthAt: { gte: new Date(Date.now() - GOOGLE_REAUTH_MAX_AGE_MS) } }, data });
    if (!done.count) back({ error: "reauth_required", form }, "#mot-de-passe");
  }
  await signIn(user.id);
  await recordTeamEvent({ kind: "team.password_changed", message: `${user.email} a ${user.hasPassword ? "changé" : "défini"} son mot de passe${unlink ? " et délié son compte Google" : ""}.`, actorId: user.id });
  await securityNotice(
    user.email,
    user.hasPassword ? "Votre mot de passe a été changé" : "Un mot de passe a été défini sur votre compte",
    `Le mot de passe de votre compte Whop Checkout (${user.email}) vient d'être ${user.hasPassword ? "changé" : "défini"}${unlink ? ", et votre compte Google a été délié" : ""}. Vos autres appareils ont été déconnectés.`,
  );
  back({ ok: user.hasPassword ? (unlink ? "password_changed_unlinked" : "password_changed") : unlink ? "password_set_unlinked" : "password_set" });
}

/**
 * Detaches the Google account: only with a password to sign in with afterwards, and the current
 * password typed again. Other devices are signed out.
 */
export async function unlinkGoogleAction(fd?: FormData) {
  const user = await requireUser();
  const form = "Compte Google";
  if (!user.googleLinked) back();
  if (!user.hasPassword) back({ error: "unlink_needs_password" }, "#mot-de-passe");
  if (!(await passwordMatches(user.id, String(fd?.get("currentPassword") ?? "")))) back({ error: "current_password", form });
  await db.adminUser.update({ where: { id: user.id }, data: { ...GOOGLE_OFF, sessionVersion: { increment: 1 } } });
  await signIn(user.id);
  await recordTeamEvent({ kind: "team.google_unlinked", message: `${user.email} a délié son compte Google.`, actorId: user.id });
  back({ ok: "google_unlinked" });
}

/** « Déconnecter mes autres appareils »: every session ends; this one is signed back in. */
export async function signOutEverywhereAction() {
  const user = await requireUser();
  await bumpSessionVersion(user.id);
  await signIn(user.id);
  await recordTeamEvent({ kind: "team.signed_out_everywhere", message: `${user.email} a déconnecté ses autres appareils.`, actorId: user.id });
  back({ ok: "signed_out_others" });
}
