import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Mail } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { hashInviteToken } from "@/lib/team";
import { Card, PageHeader, SubmitButton } from "@/components/ui";
import { AccountShell } from "@/components/dashboard/AccountShell";
import { confirmEmailChangeAction } from "../../actions";
import "../../../dashboard.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Confirmer l'e-mail", robots: { index: false, follow: false } };

/**
 * The link sent to a new sign-in address: signed in as the member who asked, one click confirms
 * (a button, not the visit itself: mail scanners open links).
 */
export default async function ConfirmEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await currentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/dashboard/account/confirm-email/${token}`)}`);
  const row = token.length <= 200 ? await db.adminUser.findFirst({ where: { id: user.id, pendingEmailTokenHash: hashInviteToken(token) }, select: { pendingEmail: true, pendingEmailExpiresAt: true } }) : null;
  const valid = !!row?.pendingEmail && !!row.pendingEmailExpiresAt && row.pendingEmailExpiresAt > new Date();
  return (
    <AccountShell user={user} active="/dashboard/account">
      <PageHeader title="Confirmer votre nouvel e-mail" icon={Mail} />
      <Card>
        {valid ? (
          <form action={confirmEmailChangeAction} className="space-y-4">
            <input type="hidden" name="token" value={token} />
            <p className="text-sm text-zinc-700">
              Votre e-mail de connexion deviendra <strong className="font-medium text-zinc-900">{row.pendingEmail}</strong> (à la place de {user.email}).
            </p>
            <SubmitButton>Confirmer ce changement</SubmitButton>
          </form>
        ) : (
          <div className="space-y-3 text-sm text-zinc-600">
            <p>Ce lien de confirmation n&apos;est plus valide : il a expiré, a déjà servi, ou concerne un autre compte que celui avec lequel vous êtes connecté.</p>
            <Link href="/dashboard/account" className="font-medium text-indigo-700 hover:underline">
              Retour au profil
            </Link>
          </div>
        )}
      </Card>
    </AccountShell>
  );
}
