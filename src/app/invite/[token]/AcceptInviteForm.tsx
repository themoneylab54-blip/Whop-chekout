"use client";

import { useActionState } from "react";
import { Flash, Input, Label, SubmitButton } from "@/components/ui";
// The shared rules (the client-safe half of @/lib/team, which re-exports them).
import { PASSWORD_MIN } from "@/lib/team-rules";
import { acceptInviteWithPasswordAction, type AcceptState } from "./actions";

/**
 * « Créer un mot de passe »: name + password, then straight into the dashboard. `reset`: an
 * access-reset link of an existing member — a new password only (its name is already known).
 */
export function AcceptInviteForm({ token, email, reset = false }: { token: string; email: string; reset?: boolean }) {
  const [state, action] = useActionState<AcceptState, FormData>(acceptInviteWithPasswordAction, {});
  return (
    <>
      <Flash error={state.error} />
      <form action={action} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        {/* For password managers: the account this password belongs to. */}
        <input type="email" name="username" value={email} autoComplete="username" readOnly hidden />
        {!reset && (
          <div>
            <Label htmlFor="name">Votre nom</Label>
            <Input key={state.name ?? ""} id="name" name="name" defaultValue={state.name ?? ""} autoComplete="name" maxLength={80} required />
          </div>
        )}
        <div>
          <Label htmlFor="password" hint={`${PASSWORD_MIN} caractères minimum`}>
            {reset ? "Nouveau mot de passe" : "Mot de passe"}
          </Label>
          <Input id="password" name="password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required />
        </div>
        <div>
          <Label htmlFor="confirm">Confirmation</Label>
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required />
        </div>
        <SubmitButton className="w-full py-2.5">{reset ? "Enregistrer et me connecter" : "Créer mon compte"}</SubmitButton>
      </form>
    </>
  );
}
