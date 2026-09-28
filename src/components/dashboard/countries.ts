/** ISO 3166-1 alpha-2 countries with French names (Intl.DisplayNames), common EU destinations first. */

const ISO = [
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ",
  "BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR",
  "CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR",
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU",
  "ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ",
  "LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ",
  "MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF",
  "PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI",
  "SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR",
  "TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW",
]
  .join(" ")
  .split(" ");

/** Shown first, in this order: where French-speaking shops ship most. */
export const COMMON_COUNTRIES = ["FR", "BE", "CH", "LU", "MC", "DE", "ES", "IT", "NL", "PT", "AT", "IE"];

let names: Intl.DisplayNames | null = null;

/** "BE" → "Belgique" (the code itself when unknown). */
export function countryName(code: string): string {
  try {
    names ??= new Intl.DisplayNames(["fr"], { type: "region" });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

export type Country = { code: string; name: string; common: boolean };

let cache: Country[] | null = null;

/** Common countries first, then every other country sorted by French name. */
export function allCountries(): Country[] {
  if (cache) return cache;
  const common = COMMON_COUNTRIES.map((code) => ({ code, name: countryName(code), common: true }));
  const rest = ISO.filter((c) => !COMMON_COUNTRIES.includes(c))
    .map((code) => ({ code, name: countryName(code), common: false }))
    // Plain comparison of folded names: identical on the server and in every browser.
    .sort((a, b) => (fold(a.name) < fold(b.name) ? -1 : fold(a.name) > fold(b.name) ? 1 : 0));
  cache = [...common, ...rest];
  return cache;
}

/** Accent- and case-insensitive text for search. */
export function fold(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** ["FR","BE"] → "France, Belgique"; [] → "Tous les pays". */
export function countriesSummary(codes: string[], max = 4): string {
  if (!codes.length) return "Tous les pays";
  const n = codes.map(countryName);
  return n.length > max ? `${n.slice(0, max).join(", ")} +${n.length - max}` : n.join(", ");
}
