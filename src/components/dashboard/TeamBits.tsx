import type { ReactNode } from "react";

/*
 * Small pieces of the team / profile screens: the member's avatar (Google photo or initial) and the
 * « Continuer avec Google » button (a form POST to /api/auth/google/start).
 */

export function UserAvatar({ name, email, avatarUrl, size = 32 }: { name?: string | null; email: string; avatarUrl?: string | null; size?: number }) {
  const initial = ((name || email).trim()[0] ?? "?").toUpperCase();
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  if (avatarUrl) {
    // Google's photo host: no referrer sent, no layout shift (fixed size).
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={avatarUrl} alt="" referrerPolicy="no-referrer" style={style} className="shrink-0 rounded-full bg-zinc-100 object-cover ring-1 ring-zinc-900/5" />;
  }
  return (
    <span aria-hidden style={style} className="flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-zinc-700 to-zinc-900 font-semibold text-white">
      {initial}
    </span>
  );
}

export function GoogleLogo({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

/**
 * « Continuer avec Google » (mode login / link / reauth / invite). A plain form: works without
 * JavaScript. `fields`: more inputs sent with it (the current password to link an account).
 */
export function GoogleButton({
  mode = "login",
  token,
  next,
  fields,
  children = "Continuer avec Google",
  className = "",
}: {
  mode?: "login" | "link" | "reauth" | "invite";
  token?: string;
  /** login: where to land once signed in (a path of this site; checked again on the server). */
  next?: string | null;
  fields?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <form action="/api/auth/google/start" method="post" className={className} data-no-draft>
      <input type="hidden" name="mode" value={mode} />
      {token && <input type="hidden" name="token" value={token} />}
      {next && <input type="hidden" name="next" value={next} />}
      {fields}
      <button
        type="submit"
        className="inline-flex w-full items-center justify-center gap-2.5 rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-zinc-800 shadow-[var(--shadow-card)] transition hover:bg-zinc-50 active:scale-[.98]"
      >
        <GoogleLogo />
        {children}
      </button>
    </form>
  );
}

/** « ou » between the Google button and the password form. */
export function OrDivider({ children = "ou" }: { children?: ReactNode }) {
  return (
    <div className="my-5 flex items-center gap-3 text-xs text-zinc-400">
      <span className="h-px flex-1 bg-zinc-200" />
      {children}
      <span className="h-px flex-1 bg-zinc-200" />
    </div>
  );
}
