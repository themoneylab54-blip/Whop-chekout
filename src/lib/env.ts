function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return value;
}

export const env = {
  get appUrl() {
    return required("APP_URL").replace(/\/$/, "");
  },
  get encryptionKey() {
    return required("ENCRYPTION_KEY");
  },
  get sessionSecret() {
    return required("SESSION_SECRET");
  },
  /** Optional: « Continuer avec Google » (dashboard sign-in). Null when unset. */
  get googleClientId() {
    return process.env.GOOGLE_CLIENT_ID?.trim() || null;
  },
  get googleClientSecret() {
    return process.env.GOOGLE_CLIENT_SECRET?.trim() || null;
  },
};
