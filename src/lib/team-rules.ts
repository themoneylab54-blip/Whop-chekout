/*
 * Rules and messages of sign-in / team screens shared by server code and client forms (no server
 * import here). Pure.
 */

export const PASSWORD_MIN = 10;
/** bcrypt only reads the first 72 bytes: a longer password would silently lose its end. */
export const PASSWORD_MAX_BYTES = 72;

export const PASSWORD_TOO_LONG_ERROR = `Mot de passe trop long : ${PASSWORD_MAX_BYTES} octets maximum (environ ${PASSWORD_MAX_BYTES} caractères sans accents, moins avec des accents ou des emojis).`;

export const PASSWORD_TOO_SHORT_ERROR = `Le mot de passe doit faire au moins ${PASSWORD_MIN} caractères.`;

/** Why a new password is refused, as a code (length in characters, size in UTF-8 bytes), or null. */
export function passwordProblemCode(password: string): "password_short" | "password_too_long" | null {
  if (password.length < PASSWORD_MIN) return "password_short";
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) return "password_too_long";
  return null;
}

/** Why a new password is refused (length in characters, size in UTF-8 bytes), or null. */
export function passwordProblem(password: string): string | null {
  const code = passwordProblemCode(password);
  return code === "password_short" ? PASSWORD_TOO_SHORT_ERROR : code === "password_too_long" ? PASSWORD_TOO_LONG_ERROR : null;
}

export const NOT_AUTHORIZED_ERROR = "Cet e-mail n'est pas autorisé. Demandez une invitation au propriétaire du compte.";
export const REMOVED_ERROR = "Ce compte a été retiré de l'équipe. Demandez une nouvelle invitation au propriétaire du compte.";
export const INVITE_INVALID_ERROR = "Cette invitation n'est plus valide (déjà utilisée, expirée ou révoquée). Demandez-en une nouvelle.";
export const ALREADY_MEMBER_ERROR = "Cet e-mail est déjà membre de l'équipe : connectez-vous.";
export const GOOGLE_TAKEN_ERROR = "Ce compte Google est déjà lié à un autre membre de l'équipe.";
export const GOOGLE_OFF_MESSAGE = "La connexion avec Google n'est pas encore activée. Demandez à la personne qui gère le site de l'activer.";

/**
 * Errors of /login and /invite/<token>, passed in the URL as a code (`?error=<code>`) and shown as
 * the fixed text below: nothing typed by anyone, nor any e-mail, travels in the URL.
 */
export const AUTH_ERRORS = {
  rate: "Trop de tentatives. Réessayez dans quelques minutes.",
  google_off: GOOGLE_OFF_MESSAGE,
  state: "Lien de connexion Google expiré ou ouvert dans un autre navigateur : recommencez.",
  cancelled: "Connexion Google annulée.",
  google_error: "Google a refusé la connexion : réessayez.",
  bad_response: "Réponse de Google invalide : recommencez.",
  google_failed: "Connexion Google impossible (réponse refusée ou e-mail Google non vérifié) : réessayez.",
  session: "Session expirée : reconnectez-vous.",
  not_authorized: NOT_AUTHORIZED_ERROR,
  removed: REMOVED_ERROR,
  invite_invalid: INVITE_INVALID_ERROR,
  already_member: ALREADY_MEMBER_ERROR,
  google_taken: GOOGLE_TAKEN_ERROR,
  other_google: "Cet e-mail est déjà lié à un autre compte Google : connectez-vous avec celui-ci, ou avec votre mot de passe.",
  unproven_email:
    "Pour protéger votre compte, connectez-vous d'abord avec votre e-mail et votre mot de passe, puis liez votre compte Google depuis votre Profil.",
  unproven_join: "Cette adresse ne peut pas rejoindre l'équipe avec Google sans lien d'invitation : demandez une invitation par e-mail.",
  invite_mismatch: "Ce compte Google ne correspond pas à l'adresse invitée : choisissez le bon compte Google.",
  inviter_gone: "La personne qui vous a invité ne peut plus accorder cet accès : demandez une nouvelle invitation.",
  invite_exceeds:
    "Cette invitation ne peut pas s'ajouter à votre accès actuel : la personne qui l'a envoyée ne peut pas vous donner ce rôle sur toutes vos boutiques. Demandez au propriétaire de modifier votre accès.",
  wrong_account: "Cette invitation est destinée à une autre adresse que celle avec laquelle vous êtes connecté.",
  conflict: "Modification simultanée de votre compte : réessayez.",
} as const;

export type AuthErrorCode = keyof typeof AUTH_ERRORS;

/** The fixed message of an error code from the URL (an unknown code shows nothing). */
export function authErrorMessage(code: string | null | undefined): string | undefined {
  return code && Object.prototype.hasOwnProperty.call(AUTH_ERRORS, code) ? AUTH_ERRORS[code as AuthErrorCode] : undefined;
}

/* ------------------------------------------------------------------ */
/* Flash codes of /dashboard, Profil and Équipe                         */
/* ------------------------------------------------------------------ */

/*
 * The dashboard's own pages get `?ok=<code>` / `?error=<code>` too, shown as the fixed text below:
 * nothing typed, no e-mail, no text of any kind is reflected from the URL (an unknown code shows
 * nothing).
 */

const TOO_MANY = "Trop de tentatives. Réessayez dans quelques minutes.";
const OTHERS_OUT = "vos autres appareils ont été déconnectés";

/** Refusals of a store page / action to a role too low (requireStoreAccess, requireStoreAction). */
export const STORE_ACCESS_ERRORS = {
  read_only: "Accès en lecture seule : vous ne pouvez pas modifier cette boutique.",
  owner_only: "Réservé au propriétaire du compte.",
} as const;

export type StoreAccessErrorCode = keyof typeof STORE_ACCESS_ERRORS;

/** /dashboard (the store list). */
export const DASHBOARD_FLASH = {
  ok: {
    self_viewer: "Vous êtes maintenant Lecteur : vous n'avez plus accès à l'Équipe.",
  },
  error: {
    ...STORE_ACCESS_ERRORS,
    team_only: "Réservé aux admins et au propriétaire.",
    create_store: "Les lecteurs ne peuvent pas ajouter de boutique.",
  },
} as const;

/**
 * A store page's `?error=` / `?ok=`: the fixed text of a known code (STORE_ACCESS_ERRORS), or one of
 * the fixed texts in `known` (messages this page's own actions send as they are); anything else —
 * text typed into a URL — shows nothing. Pure.
 */
export function storeFlashMessage(value: string | null | undefined, known: readonly string[] = []): string | undefined {
  if (!value) return undefined;
  if (Object.prototype.hasOwnProperty.call(STORE_ACCESS_ERRORS, value)) return STORE_ACCESS_ERRORS[value as StoreAccessErrorCode];
  return known.includes(value) ? value : undefined;
}

/** Profil (/dashboard/account), including the Google link / re-authentication round trips. */
export const ACCOUNT_FLASH = {
  ok: {
    profile_saved: "Profil enregistré.",
    avatar_removed: "Photo retirée.",
    email_confirm_sent: "Lien de confirmation envoyé à la nouvelle adresse : ouvrez-le dans l'heure pour valider le changement.",
    email_changed: `E-mail de connexion changé : ${OTHERS_OUT}.`,
    email_change_cancelled: "Changement d'e-mail annulé.",
    password_changed: `Mot de passe changé : ${OTHERS_OUT}.`,
    password_changed_unlinked: `Mot de passe changé : ${OTHERS_OUT}, et votre compte Google est délié.`,
    password_set: `Mot de passe défini : vous pouvez aussi vous connecter avec votre e-mail ; ${OTHERS_OUT}.`,
    password_set_unlinked: `Mot de passe défini : vous pouvez aussi vous connecter avec votre e-mail ; ${OTHERS_OUT}, et votre compte Google est délié.`,
    google_linked: "Compte Google lié : vous pouvez maintenant vous connecter avec Google. Vos autres appareils ont été déconnectés.",
    google_unlinked: "Compte Google délié : connectez-vous désormais avec votre e-mail et votre mot de passe. Vos autres appareils ont été déconnectés.",
    reauth_ok: "Identité confirmée : vous avez 5 minutes pour définir votre mot de passe.",
    signed_out_others: "Vos autres appareils ont été déconnectés.",
  },
  error: {
    ...AUTH_ERRORS,
    rate: TOO_MANY,
    email_invalid: "E-mail invalide.",
    email_needs_password: "Définissez d'abord un mot de passe pour changer d'e-mail.",
    current_password: "Mot de passe actuel incorrect.",
    email_taken: "Cet e-mail est déjà utilisé par un autre compte.",
    email_mail_failed: "L'e-mail de confirmation n'a pas pu partir : réessayez dans un instant.",
    email_pending_entry: "Cette adresse a une invitation ou un e-mail autorisé en attente : demandez d'abord qu'ils soient retirés dans l'Équipe.",
    email_link_invalid: "Ce lien de confirmation n'est plus valide (expiré, déjà utilisé, ou pour un autre compte) : refaites la demande.",
    password_short: PASSWORD_TOO_SHORT_ERROR,
    password_too_long: PASSWORD_TOO_LONG_ERROR,
    password_mismatch: "Les deux mots de passe ne correspondent pas.",
    reauth_required: "Confirmez d'abord votre identité avec Google (bouton « Confirmer avec Google »), puis définissez le mot de passe dans les 5 minutes.",
    unlink_needs_password: "Définissez d'abord un mot de passe : sans lui, vous ne pourriez plus vous connecter.",
    no_google: "Aucun compte Google n'est lié à ce profil.",
    link_password: "Mot de passe actuel incorrect : il est demandé pour lier un compte Google.",
    link_reauth_first: "Confirmez d'abord votre identité avec votre compte Google actuel.",
    reauth_other_account: "Choisissez le compte Google lié à ce profil pour confirmer votre identité.",
    reauth_not_fresh: "Google n'a pas redemandé votre mot de passe : recommencez la confirmation.",
  },
} as const;

/** Équipe (/dashboard/team). */
export const TEAM_FLASH = {
  ok: {
    role_changed: "Rôle modifié : ses sessions sont fermées, il se reconnecte avec son nouveau rôle.",
    self_role_changed: "Votre rôle a changé : vos autres appareils ont été déconnectés.",
    role_unchanged: "Rôle inchangé.",
    access_changed: "Accès aux boutiques mis à jour.",
    member_removed: "Membre retiré de l'équipe : ses sessions sont fermées.",
    invite_revoked: "Invitation révoquée : le lien ne fonctionne plus.",
    email_authorized: "E-mail autorisé : cette adresse peut maintenant se connecter avec « Continuer avec Google ».",
    email_authorized_google_off: "E-mail autorisé : cette adresse pourra se connecter avec « Continuer avec Google » dès que la connexion Google sera activée.",
    email_authorized_workspace:
      "E-mail autorisé : il fonctionnera seulement si c'est une adresse Google Workspace de ce domaine ; sinon, envoyez plutôt une invitation.",
    email_unauthorized: "E-mail retiré des e-mails autorisés (un membre déjà inscrit le reste : retirez-le de l'équipe si besoin).",
  },
  error: {
    conflict: "Modification simultanée : réessayez.",
    role_unknown: "Rôle inconnu.",
    grant_owner: "Seul un propriétaire peut nommer un propriétaire.",
    manage_owner: "Seul un propriétaire peut modifier un propriétaire.",
    remove_owner: "Seul un propriétaire peut retirer un propriétaire.",
    authorize_owner: "Seul un propriétaire peut autoriser un propriétaire.",
    member_not_found: "Membre introuvable.",
    out_of_scope: "Ce membre a accès à des boutiques que vous ne voyez pas : seul un membre ayant accès à toutes ses boutiques peut le modifier ou le retirer.",
    last_owner_demote: "Il faut au moins un propriétaire : nommez d'abord un autre propriétaire.",
    last_owner_remove: "Impossible de retirer le dernier propriétaire : nommez d'abord un autre propriétaire.",
    owner_all_stores: "Un propriétaire a toujours accès à toutes les boutiques.",
    narrow_all_stores: "Seul un membre ayant accès à toutes les boutiques peut modifier cet accès.",
    stores_outside_scope: "Vous ne pouvez donner accès qu'aux boutiques auxquelles vous avez accès.",
    stores_none: "Choisissez au moins une boutique, ou « Toutes les boutiques ».",
    no_store_to_share: "Vous n'avez accès à aucune boutique à partager : demandez au propriétaire de vous en attribuer une.",
    invite_not_found: "Invitation introuvable ou déjà utilisée.",
    invite_not_yours: "Vous ne pouvez pas gérer cette invitation.",
    email_invalid: "E-mail invalide.",
    already_member: "Cette adresse fait déjà partie de l'équipe.",
    already_authorized: "Cette adresse est déjà dans les e-mails autorisés.",
    authorized_not_found: "E-mail autorisé introuvable.",
    authorized_not_yours: "Vous ne pouvez pas gérer cet e-mail autorisé.",
    invite_rate: "Trop d'invitations envoyées pendant l'heure écoulée : réessayez plus tard.",
    actor_changed: "Votre propre accès vient de changer : rechargez la page et réessayez.",
    reset_self: "Pour votre propre compte, changez votre mot de passe depuis votre Profil.",
  },
} as const;

export type DashboardErrorCode = keyof typeof DASHBOARD_FLASH.error;
export type DashboardOkCode = keyof typeof DASHBOARD_FLASH.ok;
export type AccountErrorCode = keyof typeof ACCOUNT_FLASH.error;
export type AccountOkCode = keyof typeof ACCOUNT_FLASH.ok;
export type TeamErrorCode = keyof typeof TEAM_FLASH.error;
export type TeamOkCode = keyof typeof TEAM_FLASH.ok;

type FlashTable = { ok: Record<string, string>; error: Record<string, string> };

/** The fixed texts of a page's `?ok=` / `?error=` codes (an unknown code, or plain text, shows nothing). */
export function flashMessages(table: FlashTable, params: { ok?: string | null; error?: string | null }): { ok?: string; error?: string } {
  const pick = (map: Record<string, string>, code: string | null | undefined) => (code && Object.prototype.hasOwnProperty.call(map, code) ? map[code] : undefined);
  return { ok: pick(table.ok, params.ok), error: pick(table.error, params.error) };
}

/** /setup (first run): `?error=<code>`, shown as the fixed text below. */
export const SETUP_ERRORS = {
  token: "Code d'installation incorrect.",
  email_invalid: "E-mail invalide.",
  password_short: PASSWORD_TOO_SHORT_ERROR,
  password_too_long: PASSWORD_TOO_LONG_ERROR,
  password_mismatch: "Les deux mots de passe ne correspondent pas.",
} as const;

export type SetupErrorCode = keyof typeof SETUP_ERRORS;

/** The fixed message of a /setup error code (an unknown code shows nothing). */
export function setupErrorMessage(code: string | null | undefined): string | undefined {
  return code && Object.prototype.hasOwnProperty.call(SETUP_ERRORS, code) ? SETUP_ERRORS[code as SetupErrorCode] : undefined;
}

/** Google proves the address of this e-mail on its own (no Workspace domain needed): Gmail. Pure. */
export function isGmailAddress(email: string): boolean {
  const domain = email.split("@").pop()?.toLowerCase() ?? "";
  return domain === "gmail.com" || domain === "googlemail.com";
}

/** A `next` parameter safe to redirect to: a path of this site ("/…", never "//…" nor "/\…"), else null. */
export function safeNext(next: string | null | undefined): string | null {
  if (!next || next.length > 500 || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  // No control characters nor backslashes (browsers read "\" as "/").
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return null;
  return next;
}

/** /login with an error code, keeping where the member was headed (`next`, only when safe). */
export function loginUrl(code?: AuthErrorCode, next?: string | null): string {
  const q = new URLSearchParams();
  if (code) q.set("error", code);
  const safe = safeNext(next);
  if (safe) q.set("next", safe);
  return `/login${q.size ? `?${q}` : ""}`;
}

/** Google proves the address of a Gmail account, or of a Workspace account (`hd` = the e-mail's domain). */
export function googleProvesEmail(identity: { email: string; hd?: string | null }): boolean {
  if (isGmailAddress(identity.email)) return true;
  const domain = identity.email.split("@").pop()?.toLowerCase() ?? "";
  return !!identity.hd && identity.hd.toLowerCase() === domain;
}
