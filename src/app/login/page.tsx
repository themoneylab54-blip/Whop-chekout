import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAdminId } from "@/lib/auth";
import { db } from "@/lib/db";
import { googleAuthConfigured } from "@/lib/google-auth";
import { authErrorMessage, safeNext } from "@/lib/team";
import { AuthShell } from "@/components/dashboard/AuthShell";
import { GoogleButton, OrDivider } from "@/components/dashboard/TeamBits";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Connexion" };

/**
 * /login. `?error=<code>`: a fixed message (see AUTH_ERRORS; an unknown code shows nothing).
 * `?next=/path`: where to go after signing in, with the password or with Google (a path of this site only).
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next: rawNext } = await searchParams;
  const next = safeNext(rawNext);
  if (await currentAdminId()) redirect(next ?? "/dashboard");
  if ((await db.adminUser.count()) === 0) redirect("/setup");
  const google = googleAuthConfigured();
  return (
    <AuthShell title="Bon retour" subtitle="Connectez-vous pour gérer vos boutiques.">
      <LoginForm
        initialError={authErrorMessage(error)}
        next={next}
        google={
          google ? (
            <>
              <GoogleButton next={next} />
              <OrDivider>ou avec votre e-mail</OrDivider>
            </>
          ) : null
        }
      />
    </AuthShell>
  );
}
