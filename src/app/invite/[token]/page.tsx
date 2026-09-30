import type { Metadata } from "next";
import Link from "next/link";
import { LogOut } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { ROLE_LABELS } from "@/lib/access";
import { db } from "@/lib/db";
import { googleAuthConfigured } from "@/lib/google-auth";
import { authErrorMessage, findInviteByToken } from "@/lib/team";
import { Flash, SubmitButton } from "@/components/ui";
import { AuthShell } from "@/components/dashboard/AuthShell";
import { GoogleButton, OrDivider } from "@/components/dashboard/TeamBits";
import { acceptInviteAsMemberAction, signOutForInviteAction } from "./actions";
import { AcceptInviteForm } from "./AcceptInviteForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Invitation", robots: { index: false, follow: false } };

const REASONS = {
  expired: "Cette invitation a expiré. Demandez à la personne qui vous a invité de vous en renvoyer une.",
  accepted: "Cette invitation a déjà été utilisée. Si c'était vous, connectez-vous.",
  revoked: "Cette invitation a été annulée. Demandez-en une nouvelle si besoin.",
  noStore: "Les boutiques de cette invitation n'existent plus. Demandez à la personne qui vous a invité de vous en envoyer une nouvelle.",
  unknown: "Ce lien d'invitation n'est pas valide. Vérifiez qu'il a été copié en entier, ou demandez-en un nouveau.",
} as const;

/**
 * An invitation link: who invites, with which role and stores; join with Google or a password.
 * `?error=<code>`: a fixed message (see AUTH_ERRORS).
 */
export default async function InvitePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string }> }) {
  const { token } = await params;
  const { error } = await searchParams;
  const found = await findInviteByToken(token);
  if (!found || found.status !== "pending") {
    return (
      <AuthShell title="Invitation invalide" subtitle={REASONS[found?.status === "pending" || !found ? "unknown" : found.status]}>
        <Link href="/login" className="text-sm font-medium text-indigo-700 hover:underline">
          Aller à la connexion
        </Link>
      </AuthShell>
    );
  }
  const { invite } = found;
  const self = `/invite/${token}`;
  const inviter = invite.invitedBy ? (invite.invitedBy.name ? `${invite.invitedBy.name} (${invite.invitedBy.email})` : invite.invitedBy.email) : "L'équipe";
  const everyStore = invite.allStores || invite.role === "owner";
  const storeNames = everyStore ? [] : (await db.store.findMany({ where: { id: { in: invite.storeIds } }, select: { name: true }, orderBy: { createdAt: "asc" } })).map((s) => s.name);
  // Every store it was for was deleted since: it opens nothing (refused when used, too).
  if (!everyStore && storeNames.length === 0) {
    return (
      <AuthShell title="Invitation invalide" subtitle={REASONS.noStore}>
        <Link href="/login" className="text-sm font-medium text-indigo-700 hover:underline">
          Aller à la connexion
        </Link>
      </AuthShell>
    );
  }
  const stores = everyStore ? "toutes les boutiques" : storeNames.join(", ");
  const user = await currentUser();
  const member = user ? null : await db.adminUser.findFirst({ where: { email: invite.email, disabledAt: null }, select: { id: true } });
  // An access-reset link (« Réinitialiser l'accès »): the member chooses a new way in.
  const reset = invite.reset;

  return (
    <AuthShell
      title={reset ? "Retrouver votre accès" : "Rejoindre l'équipe"}
      subtitle={
        reset ? (
          <>
            {inviter} a réinitialisé votre accès ({ROLE_LABELS[invite.role]} sur {stores}) : choisissez un nouveau mot de passe, ou connectez-vous avec Google.
          </>
        ) : (
          <>
            {inviter} vous invite en tant que <strong className="font-medium text-zinc-800">{ROLE_LABELS[invite.role]}</strong> sur {stores}.
          </>
        )
      }
    >
      <Flash error={authErrorMessage(error)} />
      <p className="mb-5 rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-600 ring-1 ring-zinc-200">
        {reset ? "Compte" : "Invitation pour"} <strong className="font-medium text-zinc-900">{invite.email}</strong>
      </p>
      {user ? (
        user.email === invite.email ? (
          <form action={acceptInviteAsMemberAction}>
            <input type="hidden" name="token" value={token} />
            <SubmitButton className="w-full py-2.5">Accepter l&apos;invitation</SubmitButton>
          </form>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-zinc-600">
              Vous êtes connecté en tant que <strong className="font-medium text-zinc-800">{user.email}</strong>. Déconnectez-vous pour accepter l&apos;invitation avec {invite.email}.
            </p>
            <form action={signOutForInviteAction}>
              <input type="hidden" name="token" value={token} />
              <SubmitButton variant="secondary" className="w-full py-2.5">
                <LogOut className="h-4 w-4" aria-hidden /> Me déconnecter et revenir à l&apos;invitation
              </SubmitButton>
            </form>
          </div>
        )
      ) : member && !reset ? (
        <p className="text-sm text-zinc-600">
          Cet e-mail fait déjà partie de l&apos;équipe.{" "}
          <Link href={`/login?next=${encodeURIComponent(self)}`} className="font-medium text-indigo-700 hover:underline">
            Connectez-vous
          </Link>{" "}
          : vous reviendrez ici pour accepter l&apos;invitation.
        </p>
      ) : (
        <>
          {googleAuthConfigured() && (
            <>
              <GoogleButton mode="invite" token={token} />
              <p className="mt-2 text-center text-xs text-zinc-500">Avec le compte Google de {invite.email}.</p>
              <OrDivider>{reset ? "ou choisissez un nouveau mot de passe" : "ou créez un mot de passe"}</OrDivider>
            </>
          )}
          <AcceptInviteForm token={token} email={invite.email} reset={reset} />
        </>
      )}
    </AuthShell>
  );
}
