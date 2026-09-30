import type { Metadata } from "next";
import { KeyRound, LogOut, Mail, MonitorSmartphone, UserRound } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { ROLE_LABELS } from "@/lib/access";
import { db } from "@/lib/db";
import { googleAuthConfigured, GOOGLE_REAUTH_MAX_AGE_MS } from "@/lib/google-auth";
import { ACCOUNT_FLASH, flashMessages, GOOGLE_OFF_MESSAGE, PASSWORD_MIN } from "@/lib/team-rules";
import { Badge, Card, Flash, Input, Label, PageHeader, SubmitButton } from "@/components/ui";
import { ConfirmButton } from "@/components/dashboard/ConfirmButton";
import { AccountShell } from "@/components/dashboard/AccountShell";
import { GoogleButton, GoogleLogo, UserAvatar } from "@/components/dashboard/TeamBits";
import { formatDateTimeLong } from "@/components/dashboard/dates";
import { cancelEmailChangeAction, changeEmailAction, removeAvatarAction, setPasswordAction, signOutEverywhereAction, unlinkGoogleAction, updateProfileAction } from "./actions";
import "../dashboard.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Profil" };

const PASSWORD_LINK = (
  <a href="#mot-de-passe" className="font-medium text-indigo-700 underline-offset-4 hover:underline">
    définissez d&apos;abord un mot de passe
  </a>
);

function UnlinkGoogleCheckbox({ id }: { id: string }) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm text-zinc-700">
      <input id={id} type="checkbox" name="unlinkGoogle" className="h-4 w-4 rounded border-zinc-300 accent-indigo-600" />
      Délier aussi mon compte Google
    </label>
  );
}

/** Profil: name, photo, e-mail, Google account, password and sessions of the signed-in member. */
export default async function AccountPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const user = await requireUser();
  // Fixed codes only: nothing from the URL is shown as is.
  const flash = flashMessages(ACCOUNT_FLASH, await searchParams);
  const row = await db.adminUser.findUnique({ where: { id: user.id }, select: { lastLoginAt: true, createdAt: true, reauthAt: true, pendingEmail: true, pendingEmailExpiresAt: true } });
  const google = googleAuthConfigured();
  const now = new Date();
  const reauthFresh = !!row?.reauthAt && now.getTime() - row.reauthAt.getTime() <= GOOGLE_REAUTH_MAX_AGE_MS;
  const pendingEmail = row?.pendingEmail && row.pendingEmailExpiresAt && row.pendingEmailExpiresAt > now ? row.pendingEmail : null;
  // A Google-only account proves itself again with Google before adding a password.
  const needsReauth = !user.hasPassword && !reauthFresh;

  return (
    <AccountShell user={user} active="/dashboard/account">
      <PageHeader title="Profil" description="Votre nom, votre photo, vos moyens de connexion et vos sessions." icon={UserRound} />
      <Flash ok={flash.ok} error={flash.error} />

      <div className="space-y-5">
        <Card title="Identité" description="Visible par les autres membres de l'équipe." icon={UserRound}>
          <div className="flex flex-wrap items-start gap-5">
            <div className="flex flex-col items-center gap-2">
              <UserAvatar name={user.name} email={user.email} avatarUrl={user.avatarUrl} size={72} />
              {user.avatarUrl ? (
                <form action={removeAvatarAction}>
                  <button className="min-h-8 px-1 text-xs text-zinc-500 underline-offset-4 hover:text-zinc-800 hover:underline">Retirer la photo</button>
                </form>
              ) : (
                // The Google photo is only a promise when Google sign-in is on and no account is linked yet.
                <span className="max-w-[9rem] text-center text-xs text-zinc-500">{google && !user.googleLinked ? "Votre photo Google, une fois le compte lié" : "Aucune photo"}</span>
              )}
            </div>
            <form action={updateProfileAction} className="min-w-0 flex-1 basis-64 space-y-3">
              <div>
                <Label htmlFor="name">Nom</Label>
                <Input id="name" name="name" defaultValue={user.name ?? ""} maxLength={80} autoComplete="name" placeholder="Prénom Nom" />
              </div>
              <p className="text-sm text-zinc-600">
                Rôle : <Badge color={user.role === "owner" ? "blue" : "zinc"}>{ROLE_LABELS[user.role]}</Badge>
                {row?.lastLoginAt && <span className="ml-2 text-xs text-zinc-500">Dernière connexion : {formatDateTimeLong(row.lastLoginAt)}</span>}
              </p>
              <SubmitButton>Enregistrer</SubmitButton>
            </form>
          </div>
        </Card>

        <Card title="E-mail de connexion" description={user.email} icon={Mail} iconColor="#0ea5e9">
          {pendingEmail && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900 ring-1 ring-sky-600/15">
              <span>
                En attente de confirmation : <strong className="font-medium">{pendingEmail}</strong> (lien envoyé à cette adresse, valable 1 heure).
              </span>
              <form action={cancelEmailChangeAction}>
                <button className="min-h-8 px-1 text-xs font-medium text-sky-800 underline-offset-4 hover:underline" aria-label={`Annuler le changement d'e-mail vers ${pendingEmail}`}>
                  Annuler
                </button>
              </form>
            </div>
          )}
          {user.hasPassword ? (
            <form action={changeEmailAction} className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="email">Nouvel e-mail</Label>
                <Input id="email" name="email" type="email" autoComplete="email" required maxLength={200} />
              </div>
              <div>
                <Label htmlFor="email-password">Mot de passe actuel</Label>
                <Input id="email-password" name="currentPassword" type="password" autoComplete="current-password" required />
              </div>
              <div className="sm:col-span-2">
                <SubmitButton variant="secondary">Changer d&apos;e-mail</SubmitButton>
              </div>
            </form>
          ) : (
            <p className="text-sm text-zinc-500">Pour changer d&apos;e-mail, {PASSWORD_LINK} (ci-dessous).</p>
          )}
        </Card>

        <Card
          title={
            <span className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-zinc-200">
                <GoogleLogo className="h-5 w-5" />
              </span>
              Compte Google
            </span>
          }
          description="Connectez-vous en un clic avec « Continuer avec Google »."
          actions={user.googleLinked ? <Badge color="green">Lié</Badge> : <Badge color="zinc">Non lié</Badge>}
        >
          {user.googleLinked ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="flex min-w-0 items-center gap-2 text-sm text-zinc-600">
                <GoogleLogo />
                <span className="min-w-0 truncate">
                  Lié au compte Google <strong className="font-medium text-zinc-900">{user.googleEmail ?? "(adresse inconnue : reconnectez-vous avec Google pour l'afficher)"}</strong>
                </span>
              </p>
              {user.hasPassword ? (
                <form action={unlinkGoogleAction} className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
                  <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">
                    <Label htmlFor="unlink-password" hint="Pour confirmer que c'est bien vous">
                      Mot de passe actuel
                    </Label>
                    <Input id="unlink-password" name="currentPassword" type="password" autoComplete="current-password" required />
                  </div>
                  {/* The password typed again is the confirmation (a dialog would hide the field it asks for). */}
                  <SubmitButton variant="secondary" size="sm" className="min-h-10">
                    Délier Google
                  </SubmitButton>
                  <p className="w-full text-xs text-zinc-500">Vous vous connecterez ensuite avec votre e-mail et votre mot de passe. Vos autres appareils seront déconnectés.</p>
                </form>
              ) : (
                <p className="w-full text-xs text-zinc-500">Pour pouvoir délier Google, {PASSWORD_LINK} (sinon vous ne pourriez plus vous connecter).</p>
              )}
            </div>
          ) : google ? (
            <div className="max-w-sm">
              <GoogleButton
                mode="link"
                fields={
                  <div className="mb-3">
                    <Label htmlFor="link-password" hint="Pour confirmer que c'est bien vous">
                      Mot de passe actuel
                    </Label>
                    <Input id="link-password" name="currentPassword" type="password" autoComplete="current-password" required />
                  </div>
                }
              >
                Lier mon compte Google
              </GoogleButton>
              <p className="mt-2 text-xs text-zinc-500">
                Google vous redemandera votre mot de passe Google. Choisissez le compte avec lequel vous voulez vous connecter : il peut avoir une autre adresse que {user.email}. Vos autres
                appareils seront déconnectés.
              </p>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">{GOOGLE_OFF_MESSAGE}</p>
          )}
        </Card>

        <Card
          id="mot-de-passe"
          title={user.hasPassword ? "Mot de passe" : "Définir un mot de passe"}
          description={user.hasPassword ? "Changer de mot de passe déconnecte vos autres appareils." : "Pour vous connecter aussi avec votre e-mail, en secours de Google."}
          icon={KeyRound}
          iconColor="#f59e0b"
        >
          {needsReauth ? (
            <div className="max-w-sm space-y-2">
              <p className="text-sm text-zinc-600">Pour votre sécurité, confirmez d&apos;abord votre identité avec le compte Google lié à ce profil : vous aurez ensuite 5 minutes pour choisir le mot de passe.</p>
              {google ? <GoogleButton mode="reauth">Confirmer avec Google</GoogleButton> : <p className="text-sm text-zinc-500">{GOOGLE_OFF_MESSAGE}</p>}
            </div>
          ) : (
            <form action={setPasswordAction} className="grid gap-3 sm:grid-cols-2">
              {user.hasPassword && (
                <div className="sm:col-span-2 sm:max-w-[calc(50%-.375rem)]">
                  <Label htmlFor="currentPassword">Mot de passe actuel</Label>
                  <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
                </div>
              )}
              <div>
                <Label htmlFor="password" hint={`${PASSWORD_MIN} caractères minimum`}>
                  Nouveau mot de passe
                </Label>
                <Input id="password" name="password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required />
              </div>
              <div>
                <Label htmlFor="confirm" hint="Pour éviter une faute de frappe">
                  Confirmation
                </Label>
                <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required />
              </div>
              {user.googleLinked && (
                <div className="sm:col-span-2">
                  <UnlinkGoogleCheckbox id="password-unlink-google" />
                </div>
              )}
              <div className="sm:col-span-2">
                <SubmitButton variant="secondary">{user.hasPassword ? "Changer le mot de passe" : "Définir le mot de passe"}</SubmitButton>
              </div>
            </form>
          )}
        </Card>

        <Card title="Sessions" description="Un appareil perdu, un ordinateur partagé : fermez toutes les autres sessions d'un coup." icon={MonitorSmartphone} iconColor="#64748b">
          <form action={signOutEverywhereAction} className="space-y-3">
            <ConfirmButton
              variant="secondary"
              tone="default"
              title="Déconnecter vos autres appareils ?"
              description="Toutes vos autres sessions sont fermées ; cet appareil reste connecté."
              confirmLabel="Déconnecter"
            >
              <LogOut className="h-4 w-4" aria-hidden /> Déconnecter mes autres appareils
            </ConfirmButton>
          </form>
        </Card>
      </div>
    </AccountShell>
  );
}
