"use client";

import { useActionState, useState } from "react";
import { KeyRound, RefreshCw, Send } from "lucide-react";
import type { UserRole } from "@prisma/client";
import { CopyField, Flash, Input, Label, Select, SubmitButton } from "@/components/ui";
import { ConfirmButton } from "@/components/dashboard/ConfirmButton";
import { createInviteAction, resendInviteAction, resetMemberAccessAction, updateMemberRoleAction, type InviteState } from "./actions";

export type StoreOption = { id: string; name: string };

const ROLE_HINTS: Record<UserRole, string> = {
  owner: "Tout, y compris l'équipe et les connexions de paiement",
  admin: "Modifie les boutiques (hors paiements et clés API), invite des admins et des lecteurs",
  viewer: "Consulte sans rien modifier",
};

/**
 * Role + store access of a member / invitation: « Toutes les boutiques » or a selection (hidden for
 * an owner, who always sees everything). `stores` = what the current member may grant.
 */
export function AccessFields({
  stores,
  canAll,
  defaultAll,
  defaultIds = [],
  idPrefix,
}: {
  stores: StoreOption[];
  canAll: boolean;
  defaultAll: boolean;
  defaultIds?: string[];
  idPrefix: string;
}) {
  const [all, setAll] = useState(canAll && defaultAll);
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 text-[13px] font-medium text-zinc-800">Boutiques</legend>
      {canAll && (
        <label className="flex items-center gap-2 text-sm text-zinc-800">
          <input type="checkbox" name="allStores" checked={all} onChange={(e) => setAll(e.target.checked)} className="h-4 w-4 rounded border-zinc-300 accent-indigo-600" />
          Toutes les boutiques <span className="text-xs text-zinc-500">(y compris les futures)</span>
        </label>
      )}
      {!all && (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {stores.length === 0 && <p className="text-sm text-zinc-500">Aucune boutique à partager.</p>}
          {stores.map((s) => (
            <label key={s.id} htmlFor={`${idPrefix}-${s.id}`} className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-50">
              <input id={`${idPrefix}-${s.id}`} type="checkbox" name="storeIds" value={s.id} defaultChecked={defaultIds.includes(s.id)} className="h-4 w-4 shrink-0 rounded border-zinc-300 accent-indigo-600" />
              <span className="truncate">{s.name}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

/** Role picker + the store access it needs (none for an owner). */
export function RoleAccessFields({ roles, stores, canAll, idPrefix, defaultRole = "admin" }: { roles: { value: UserRole; label: string }[]; stores: StoreOption[]; canAll: boolean; idPrefix: string; defaultRole?: UserRole }) {
  const [role, setRole] = useState<UserRole>(roles.some((r) => r.value === defaultRole) ? defaultRole : (roles[roles.length - 1]?.value ?? "viewer"));
  return (
    <>
      <div>
        <Label htmlFor={`${idPrefix}-role`} hint={ROLE_HINTS[role]}>
          Rôle
        </Label>
        <Select id={`${idPrefix}-role`} name="role" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
          {roles.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </div>
      {role === "owner" ? (
        <p className="text-sm text-zinc-500">Un propriétaire a accès à toutes les boutiques.</p>
      ) : (
        <AccessFields stores={stores} canAll={canAll} defaultAll={canAll} idPrefix={idPrefix} />
      )}
    </>
  );
}

/** The link of an invitation just created / renewed: shown once (only its hash is stored). */
function LinkOnce({ state }: { state: InviteState }) {
  if (!state.link) return null;
  return (
    <div className="mt-4 space-y-2 rounded-xl bg-indigo-50/60 p-3 ring-1 ring-indigo-600/10">
      {state.warning && <p className="text-sm text-amber-800">{state.warning}</p>}
      <CopyField value={state.link} label="Lien d'invitation (personnel, valable 7 jours) — il ne sera plus affiché ensuite" />
    </div>
  );
}

export function InviteForm({ roles, stores, canAll }: { roles: { value: UserRole; label: string }[]; stores: StoreOption[]; canAll: boolean }) {
  const [state, action] = useActionState<InviteState, FormData>(createInviteAction, {});
  return (
    <div>
      <Flash ok={state.ok} error={state.error} />
      {/* Remount after a success: the next invitation starts from an empty form. */}
      <form key={state.link ?? "invite"} action={action} className="space-y-4">
        <div>
          <Label htmlFor="invite-email">E-mail</Label>
          <Input id="invite-email" name="email" type="email" required maxLength={200} defaultValue={state.link ? "" : (state.email ?? "")} placeholder="prenom@exemple.com" autoComplete="off" />
        </div>
        <RoleAccessFields roles={roles} stores={stores} canAll={canAll} idPrefix="invite" />
        <SubmitButton>
          <Send className="h-4 w-4" aria-hidden /> Inviter
        </SubmitButton>
      </form>
      <LinkOnce state={state} />
    </div>
  );
}

/**
 * A member's role picker + « Changer »: the button (and its confirmation) only once another role is
 * picked — an unchanged role has nothing to confirm.
 */
export function RoleChangeForm({
  memberId,
  email,
  role,
  roles,
  title,
  description,
}: {
  memberId: string;
  email: string;
  role: UserRole;
  roles: { value: UserRole; label: string }[];
  title: string;
  description: string;
}) {
  const [picked, setPicked] = useState<UserRole>(role);
  const same = picked === role;
  return (
    <form action={updateMemberRoleAction} className="flex items-center gap-2">
      <input type="hidden" name="memberId" value={memberId} />
      <label htmlFor={`role-${memberId}`} className="sr-only">
        Rôle de {email}
      </label>
      <Select id={`role-${memberId}`} name="role" value={picked} onChange={(e) => setPicked(e.target.value as UserRole)} className="min-h-8 !w-auto !py-1.5 text-xs">
        {roles.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </Select>
      <ConfirmButton
        size="sm"
        variant="secondary"
        tone="default"
        disabled={same}
        aria-label={`Changer le rôle de ${email}`}
        title={title}
        description={description}
        confirmLabel="Changer le rôle"
      >
        Changer
      </ConfirmButton>
    </form>
  );
}

/** « Renvoyer »: a new link (the previous one stops working), e-mailed when possible, shown once. */
export function ResendInvite({ inviteId, email }: { inviteId: string; email: string }) {
  const [state, action] = useActionState<InviteState, FormData>(resendInviteAction, {});
  return (
    <div className="contents">
      <form action={action}>
        <input type="hidden" name="inviteId" value={inviteId} />
        <SubmitButton variant="secondary" size="sm" aria-label={`Renvoyer l'invitation de ${email}`}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Renvoyer
        </SubmitButton>
      </form>
      {(state.error || state.link) && (
        <div className="w-full basis-full">
          {state.error && <p className="mt-2 text-sm text-red-700">{state.error}</p>}
          {state.ok && <p className="mt-2 text-sm text-emerald-700">{state.ok}</p>}
          <LinkOnce state={state} />
        </div>
      )}
    </div>
  );
}

/**
 * « Réinitialiser l'accès » (forgotten password): the member's password and Google account are
 * cleared, its sessions end, and a new personal link lets it choose a new way in — e-mailed when
 * possible, shown once here.
 */
export function ResetAccess({ memberId, email }: { memberId: string; email: string }) {
  const [state, action] = useActionState<InviteState, FormData>(resetMemberAccessAction, {});
  return (
    <div className="contents">
      <form action={action}>
        <input type="hidden" name="memberId" value={memberId} />
        <ConfirmButton
          size="sm"
          variant="ghost"
          tone="default"
          aria-label={`Réinitialiser l'accès de ${email}`}
          title={`Réinitialiser l'accès de ${email} ?`}
          description="Ses sessions sont fermées, son mot de passe et son compte Google retirés. Un nouveau lien personnel (7 jours) lui permet de choisir un mot de passe ou de se connecter avec Google ; son rôle et ses boutiques ne changent pas."
          confirmLabel="Réinitialiser"
        >
          <KeyRound className="h-3.5 w-3.5" aria-hidden /> Réinitialiser l&apos;accès
        </ConfirmButton>
      </form>
      {(state.error || state.link) && (
        <div className="w-full basis-full">
          {state.error && <p className="mt-2 text-sm text-red-700">{state.error}</p>}
          {state.ok && <p className="mt-2 text-sm text-emerald-700">{state.ok}</p>}
          <LinkOnce state={state} />
        </div>
      )}
    </div>
  );
}
