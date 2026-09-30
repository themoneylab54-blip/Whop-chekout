import type { UserRole } from "@prisma/client";

/**
 * Account / pixel ids used together with an owner-only token or key (API keys and tokens are the
 * account owner's): while that token is stored, only the owner may change the id — otherwise an
 * admin could point the owner's token at another ad account, pixel, Telegram chat or sender.
 * Without a stored token the id is a plain setting (anyone who may edit the store sets it).
 */
export const OWNER_BOUND_LABELS = {
  metaPixelId: "l'ID du pixel Meta",
  tiktokPixelId: "le code du pixel TikTok",
  ga4MeasurementId: "l'ID de mesure GA4",
  metaAdAccountId: "l'ID du compte publicitaire Meta",
  tiktokAdvertiserId: "l'ID annonceur TikTok",
  googleAdsConversionAction: "l'action de conversion Google Ads",
  emailFrom: "l'expéditeur des e-mails",
  telegramChatId: "l'ID de conversation Telegram",
  mondialRelayEnseigne: "le code enseigne Mondial Relay",
} as const;

export type OwnerBoundField = keyof typeof OWNER_BOUND_LABELS;

/** A Google Ads secret (owner-only) is stored: the offline conversion action is then bound to it. */
export function googleAdsTokenStored(store: { googleAdsRefreshToken: string | null; googleAdsDeveloperToken: string | null; googleAdsClientSecret: string | null }): boolean {
  return !!(store.googleAdsRefreshToken || store.googleAdsDeveloperToken || store.googleAdsClientSecret);
}

/** The id is locked for `role`: a related token is stored and the user isn't the owner. */
export function ownerBoundLocked(role: UserRole, tokenStored: boolean): boolean {
  return tokenStored && role !== "owner";
}

/**
 * Resolves the submitted ids: a locked id that changed keeps its current value and is reported in
 * `refused` (the other fields are saved as submitted). Blank and null are the same value.
 */
export function resolveOwnerBound<K extends OwnerBoundField>(
  role: UserRole,
  fields: Record<K, { next: string | null; current: string | null; tokenStored: boolean }>,
): { values: Record<K, string | null>; refused: K[] } {
  const values = {} as Record<K, string | null>;
  const refused: K[] = [];
  for (const key of Object.keys(fields) as K[]) {
    const { next, current, tokenStored } = fields[key];
    const changed = (next || null) !== (current || null);
    if (changed && ownerBoundLocked(role, tokenStored)) {
      values[key] = current;
      refused.push(key);
    } else {
      values[key] = next || null;
    }
  }
  return { values, refused };
}

/** French refusal naming the ids that were kept (the rest of the form was saved). */
export function ownerBoundError(refused: readonly OwnerBoundField[], othersSaved = true): string {
  const names = refused.map((k) => OWNER_BOUND_LABELS[k]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}` : names[0];
  return (
    `Seul le propriétaire du compte peut changer ${list} : sa clé ou son jeton enregistré s'en sert.` +
    (othersSaved ? " Les autres réglages ont été enregistrés." : "")
  );
}
