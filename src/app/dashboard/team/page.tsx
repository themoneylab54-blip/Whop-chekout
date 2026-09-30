import type { Metadata } from "next";
import { KeyRound, MailCheck, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import type { UserRole } from "@prisma/client";
import { accessibleStoreWhere, canGrantRole, canManageMember, requireRole, ROLE_LABELS } from "@/lib/access";
import { db } from "@/lib/db";
import { googleAuthConfigured } from "@/lib/google-auth";
import { inviteStatus } from "@/lib/team";
import { flashMessages, GOOGLE_OFF_MESSAGE, TEAM_FLASH } from "@/lib/team-rules";
import { Badge, Card, Flash, Input, Label, PageHeader, SubmitButton } from "@/components/ui";
import { ConfirmButton } from "@/components/dashboard/ConfirmButton";
import { AccountShell } from "@/components/dashboard/AccountShell";
import { UserAvatar } from "@/components/dashboard/TeamBits";
import { formatDateTimeLong, formatWhen } from "@/components/dashboard/dates";
import { removeAuthorizedEmailAction, removeMemberAction, revokeInviteAction, updateMemberAccessAction, addAuthorizedEmailAction } from "./actions";
import { AccessFields, InviteForm, ResendInvite, ResetAccess, RoleAccessFields, RoleChangeForm } from "./TeamForms";
import "../dashboard.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Équipe" };

const ROLE_ORDER: UserRole[] = ["owner", "admin", "viewer"];
const ROLE_COLOR = { owner: "blue", admin: "green", viewer: "zinc" } as const;

const NOTHING_TO_SHARE = (
  <p className="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-600 ring-1 ring-zinc-200">
    Vous n&apos;avez accès à aucune boutique pour l&apos;instant : il n&apos;y a rien à partager. Demandez au propriétaire de vous attribuer une boutique pour inviter quelqu&apos;un.
  </p>
);

/** Équipe (admins and owners): members, invitations and authorized e-mails. */
export default async function TeamPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const actor = await requireRole("admin", "team_only");
  const sp = await searchParams;
  const now = new Date();
  const [allMembers, allInvites, allStoreRows, myStores] = await Promise.all([
    db.adminUser.findMany({
      where: { disabledAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        role: true,
        allStores: true,
        lastLoginAt: true,
        passwordHash: true,
        googleSub: true,
        googleEmail: true,
        storeAccess: { select: { storeId: true } },
      },
    }),
    db.teamInvite.findMany({
      where: { revokedAt: null, acceptedAt: null },
      orderBy: { createdAt: "desc" },
      include: { invitedBy: { select: { name: true, email: true } } },
    }),
    db.store.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, name: true } }),
    db.store.findMany({ where: accessibleStoreWhere(actor), orderBy: { createdAt: "asc" }, select: { id: true, name: true } }),
  ]);
  const storeName = new Map(allStoreRows.map((s) => [s.id, s.name]));
  const myStoreIds = new Set(myStores.map((s) => s.id));
  // An admin limited to some stores only sees the members and invitations sharing one of them (and itself).
  const shares = (e: { allStores: boolean; role: UserRole }, ids: string[]) => actor.allStores || e.allStores || e.role === "owner" || ids.some((id) => myStoreIds.has(id));
  const members = allMembers.filter((m) => m.id === actor.id || shares(m, m.storeAccess.map((a) => a.storeId)));
  const invites = allInvites.filter((i) => shares(i, i.storeIds));
  const grantable = ROLE_ORDER.filter((r) => canGrantRole(actor.role, r)).map((r) => ({ value: r, label: ROLE_LABELS[r] }));
  const memberEmails = new Set(members.map((m) => m.email));
  const pending = invites.filter((i) => i.tokenHash);
  const authorized = invites.filter((i) => !i.tokenHash);
  const google = googleAuthConfigured();
  // Limited to some stores, none of which exists: nothing to invite anyone to (refused on the server too).
  const nothingToShare = !actor.allStores && myStores.length === 0;
  // Fixed codes only: nothing from the URL is shown as is.
  const flash = flashMessages(TEAM_FLASH, sp);

  /** "toutes les boutiques" or the names (those the actor can see; the others counted). */
  const accessText = (allStores: boolean, ids: string[]) => {
    if (allStores) return "Toutes les boutiques";
    const names = ids.filter((id) => storeName.has(id) && (actor.allStores || myStoreIds.has(id))).map((id) => storeName.get(id)!);
    const hidden = ids.filter((id) => storeName.has(id) && !actor.allStores && !myStoreIds.has(id)).length;
    const parts = [...names, ...(hidden ? [`+${hidden} autre${hidden > 1 ? "s" : ""}`] : [])];
    return parts.length ? parts.join(", ") : "Aucune boutique";
  };

  return (
    <AccountShell user={actor} active="/dashboard/team">
      <PageHeader title="Équipe" description="Qui accède au dashboard, avec quel rôle et sur quelles boutiques." icon={Users} />
      <Flash ok={flash.ok} error={flash.error} />

      <div className="space-y-5">
        <Card
          title={`Membres (${members.length})`}
          description="Propriétaire : tout. Admin : modifie les boutiques (hors paiements et clés API), invite des admins et des lecteurs. Lecteur : consulte seulement."
          icon={Users}
        >
          <ul className="divide-y divide-zinc-100">
            {members.map((m) => {
              const me = m.id === actor.id;
              const ids = m.storeAccess.map((a) => a.storeId);
              // A limited admin only manages members whose stores are all among its own.
              const manageable = canManageMember(actor, m) && (actor.allStores || (!m.allStores && m.role !== "owner" && ids.every((id) => myStoreIds.has(id))));
              const demoteSelf = me && m.role !== "viewer";
              return (
                <li key={m.id} className="flex flex-wrap items-start gap-x-4 gap-y-3 py-4 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
                    <UserAvatar name={m.name} email={m.email} avatarUrl={m.avatarUrl} size={36} />
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-zinc-900">
                        <span className="truncate">{m.name || m.email}</span>
                        {me && <Badge dot={false}>Vous</Badge>}
                      </p>
                      {m.name && <p className="truncate text-xs text-zinc-500">{m.email}</p>}
                      <p className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge color={ROLE_COLOR[m.role]}>{ROLE_LABELS[m.role]}</Badge>
                        {m.googleSub && (
                          <span title={m.googleEmail ? `Compte Google : ${m.googleEmail}` : undefined}>
                            <Badge dot={false}>
                              Google
                              {/* The address itself, for screen readers (shown below when it differs from the e-mail). */}
                              {m.googleEmail && <span className="sr-only"> : {m.googleEmail}</span>}
                            </Badge>
                          </span>
                        )}
                        {m.passwordHash && <Badge dot={false}>Mot de passe</Badge>}
                        {!m.googleSub && !m.passwordHash && <Badge color="amber">Aucun moyen de connexion</Badge>}
                      </p>
                      {m.googleSub && m.googleEmail && m.googleEmail !== m.email && (
                        <p className="truncate text-xs text-zinc-500" aria-hidden>
                          Compte Google : {m.googleEmail}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-zinc-500">
                        {accessText(m.allStores || m.role === "owner", ids)} · {m.lastLoginAt ? `Dernière connexion : ${formatWhen(m.lastLoginAt, now)}` : "Jamais connecté"}
                      </p>
                    </div>
                  </div>
                  {manageable && (
                    <div className="flex flex-wrap items-center gap-2">
                      <RoleChangeForm
                        memberId={m.id}
                        email={m.email}
                        role={m.role}
                        roles={ROLE_ORDER.filter((r) => r === m.role || canGrantRole(actor.role, r)).map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
                        title={me ? "Changer votre propre rôle ?" : `Changer le rôle de ${m.email} ?`}
                        description={
                          me
                            ? demoteSelf
                              ? "Vos sessions sur vos autres appareils sont fermées. Si vous passez Lecteur, vous perdrez l'accès à l'Équipe et ne pourrez plus revenir en arrière vous-même."
                              : "Vos sessions sur vos autres appareils sont fermées."
                            : "Ses sessions sont fermées tout de suite : il se reconnecte avec son nouveau rôle. Les invitations qu'il a envoyées et qu'il ne peut plus accorder sont révoquées."
                        }
                      />
                      {!me && <ResetAccess memberId={m.id} email={m.email} />}
                      <form action={removeMemberAction}>
                        <input type="hidden" name="memberId" value={m.id} />
                        <ConfirmButton
                          size="sm"
                          variant="ghost"
                          aria-label={`Retirer ${m.email}`}
                          title={me ? "Vous retirer de l'équipe ?" : `Retirer ${m.email} ?`}
                          description={
                            me
                              ? "Vous serez déconnecté et ne pourrez plus revenir sans nouvelle invitation."
                              : "Ses sessions sont fermées tout de suite, son mot de passe et son compte Google sont détachés, et ses invitations en attente révoquées ; il ne pourra revenir que par une nouvelle invitation."
                          }
                          confirmLabel="Retirer"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden /> Retirer
                        </ConfirmButton>
                      </form>
                    </div>
                  )}
                  {manageable && m.role !== "owner" && (actor.allStores || !m.allStores) && (
                    <details className="group w-full basis-full pl-12">
                      <summary className="inline-flex min-h-8 cursor-pointer list-none items-center text-xs font-medium text-indigo-700 hover:underline [&::-webkit-details-marker]:hidden">
                        Modifier l&apos;accès aux boutiques
                      </summary>
                      <form action={updateMemberAccessAction} className="mt-2 space-y-3 rounded-xl bg-zinc-50 p-3">
                        <input type="hidden" name="memberId" value={m.id} />
                        <AccessFields stores={myStores} canAll={actor.allStores} defaultAll={m.allStores} defaultIds={ids} idPrefix={`access-${m.id}`} />
                        <SubmitButton size="sm">Enregistrer l&apos;accès</SubmitButton>
                      </form>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title="Inviter un membre" description="Un lien personnel, valable 7 jours et utilisable une fois : par e-mail si l'envoi est configuré, sinon à copier." icon={UserPlus} iconColor="#8b5cf6">
          {nothingToShare ? NOTHING_TO_SHARE : <InviteForm roles={grantable} stores={myStores} canAll={actor.allStores} />}
        </Card>

        <Card title={`Invitations en attente (${pending.length})`} icon={MailCheck} iconColor="#0ea5e9">
          {pending.length === 0 ? (
            <p className="text-sm text-zinc-500">Aucune invitation en attente.</p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {pending.map((i) => {
                const status = inviteStatus(i, now);
                const inviter = i.invitedBy ? i.invitedBy.name || i.invitedBy.email : "—";
                const handle = canGrantRole(actor.role, i.role) && (actor.allStores || (!i.allStores && i.storeIds.every((id) => myStoreIds.has(id))));
                return (
                  <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1 basis-64">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-zinc-900">
                        <span className="truncate">{i.email}</span>
                        <Badge color={ROLE_COLOR[i.role]}>{ROLE_LABELS[i.role]}</Badge>
                        {status === "expired" ? <Badge color="amber">Expirée</Badge> : <Badge color="zinc">En attente</Badge>}
                        {i.reset ? <Badge color="blue">Réinitialisation d&apos;accès</Badge> : memberEmails.has(i.email) && <Badge color="green">Déjà membre</Badge>}
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {accessText(i.allStores || i.role === "owner", i.storeIds)} · Invité par {inviter}
                        {i.expiresAt && ` · ${status === "expired" ? "a expiré le" : "expire le"} ${formatDateTimeLong(i.expiresAt)}`}
                      </p>
                    </div>
                    {handle && (
                      // `contents`: the buttons sit in the row, and a renewed link opens full width under it.
                      <div className="contents">
                        <ResendInvite inviteId={i.id} email={i.email} />
                        <form action={revokeInviteAction}>
                          <input type="hidden" name="inviteId" value={i.id} />
                          <ConfirmButton size="sm" variant="ghost" aria-label={`Révoquer l'invitation de ${i.email}`} title={`Révoquer l'invitation de ${i.email} ?`} description="Le lien ne fonctionnera plus." confirmLabel="Révoquer">
                            Révoquer
                          </ConfirmButton>
                        </form>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card
          id="emails-autorises"
          title={`E-mails autorisés (${authorized.length})`}
          description="Ces adresses Gmail (ou Google Workspace de leur domaine) peuvent rejoindre l'équipe d'elles-mêmes avec « Continuer avec Google », sans lien d'invitation. Pour une autre adresse, envoyez une invitation."
          icon={ShieldCheck}
          iconColor="#16a34a"
        >
          {!google && (
            <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-600/15">
              {GOOGLE_OFF_MESSAGE} D&apos;ici là, ces adresses ne peuvent pas se connecter.
            </p>
          )}
          {authorized.length > 0 && (
            <ul className="mb-5 divide-y divide-zinc-100">
              {authorized.map((a) => {
                const handle = canGrantRole(actor.role, a.role) && (actor.allStores || (!a.allStores && a.storeIds.every((id) => myStoreIds.has(id))));
                return (
                  <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0">
                    <div className="min-w-0 flex-1 basis-64">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-zinc-900">
                        <span className="truncate">{a.email}</span>
                        <Badge color={ROLE_COLOR[a.role]}>{ROLE_LABELS[a.role]}</Badge>
                        {memberEmails.has(a.email) && <Badge color="green">Membre actif</Badge>}
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-500">{accessText(a.allStores || a.role === "owner", a.storeIds)}</p>
                    </div>
                    {handle && (
                      <form action={removeAuthorizedEmailAction}>
                        <input type="hidden" name="inviteId" value={a.id} />
                        <ConfirmButton
                          size="sm"
                          variant="ghost"
                          aria-label={`Retirer ${a.email} des e-mails autorisés`}
                          title={`Retirer ${a.email} des e-mails autorisés ?`} description="Un membre déjà inscrit avec cette adresse le reste." confirmLabel="Retirer">
                          Retirer
                        </ConfirmButton>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {nothingToShare ? (
            <div className="border-t border-zinc-100 pt-4">{NOTHING_TO_SHARE}</div>
          ) : (
            <form action={addAuthorizedEmailAction} className="space-y-4 border-t border-zinc-100 pt-4">
              <div>
                <Label htmlFor="authorized-email">E-mail Google à autoriser</Label>
                <Input id="authorized-email" name="email" type="email" required maxLength={200} placeholder="prenom@gmail.com" autoComplete="off" />
              </div>
              <RoleAccessFields roles={grantable} stores={myStores} canAll={actor.allStores} idPrefix="authorized" />
              <SubmitButton variant="secondary">
                <KeyRound className="h-4 w-4" aria-hidden /> Autoriser cet e-mail
              </SubmitButton>
            </form>
          )}
        </Card>
      </div>
    </AccountShell>
  );
}
