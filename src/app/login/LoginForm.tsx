"use client";

import { useActionState } from "react";
import { Flash, Input, Label, SubmitButton } from "@/components/ui";
import { loginAction, type LoginState } from "../dashboard/actions";

/** Login form: a failed attempt shows the error and keeps the typed e-mail (password is cleared). */
export function LoginForm({ initialError }: { initialError?: string }) {
  const [state, action] = useActionState<LoginState, FormData>(loginAction, { error: initialError });
  return (
    <>
      <Flash error={state.error} />
      <form action={action} className="space-y-4">
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
    </>
  );
}
