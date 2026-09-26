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
};
