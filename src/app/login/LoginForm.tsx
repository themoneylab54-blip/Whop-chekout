"use client";

import { useActionState, type ReactNode } from "react";
import { Flash, Input, Label, SubmitButton } from "@/components/ui";
import { passwordLoginAction, type LoginState } from "./actions";

/**
 * Login form: a failed attempt shows the error and keeps the typed e-mail (password is cleared).
 * `google`: the « Continuer avec Google » button, above the password form (when configured).
 * `next`: where to go once signed in (checked again on the server).
 */
export function LoginForm({ initialError, google, next }: { initialError?: string; google?: ReactNode; next?: string | null }) {
  const [state, action] = useActionState<LoginState, FormData>(passwordLoginAction, { error: initialError });
  return (
    <>
      <Flash error={state.error} />
      {google}
      <form action={action} className="space-y-4">
        {next && <input type="hidden" name="next" value={next} />}
        <div>
          <Label htmlFor="email">E-mail</Label>
          <Input
            // Remount with the returned value: React resets the form after the action runs.
            key={state.email ?? ""}
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            defaultValue={state.email ?? ""}
            aria-invalid={state.error ? true : undefined}
            required
            autoFocus={!state.email}
          />
        </div>
        <div>
          <Label htmlFor="password">Mot de passe</Label>
          <Input
            key={state.error ? `${state.email}-retry` : "password"}
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={state.error ? true : undefined}
            required
            autoFocus={!!state.email}
          />
        </div>
        <SubmitButton className="w-full py-2.5">Se connecter</SubmitButton>
      </form>
      {/* No self-service reset: the owner (or an admin) resets the access from Équipe. */}
      <p className="mt-4 text-center text-xs leading-relaxed text-zinc-500">
        <strong className="font-medium text-zinc-600">Mot de passe oublié ?</strong> Connectez-vous avec Google si votre compte est lié, sinon demandez au propriétaire de vous réinviter.
      </p>
    </>
  );
}
