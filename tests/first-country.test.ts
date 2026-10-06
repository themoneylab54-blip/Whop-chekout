import { describe, expect, it } from "vitest";
import { checkoutCountries, countryHints, LANG_COUNTRY, pickFirstCountry, POPULAR_COUNTRIES, shipsToCountry, storeMarketOf } from "@/lib/first-country";

/*
 * The country the checkout pre-selects. A French buyer on a store shipping to the USA got
 * « Algérie »: IP (FR) and locale (fr-FR) not shipped to, the main-market lookup timed out (800 ms),
 * FR (the language's) not listed, so the list's alphabetically first won. Now the store's dedicated
 * rate, then the most common market it ships to, come before that last resort.
 */

const codes = (rates: { countries: string[]; active?: boolean }[], lang: "fr" | "en" = "fr") => checkoutCountries(rates, lang).map((c) => c.code);

describe("pickFirstCountry", () => {
  it("the IP country when shipped to, then the locale's, then the main market", () => {
    const list = codes([{ countries: ["US", "FR", "DE"] }]);
    expect(pickFirstCountry(list, { initialCountry: "DE", localeCountry: "FR", primaryCountry: "US", language: "fr" })).toBe("DE");
    expect(pickFirstCountry(list, { initialCountry: "JP", localeCountry: "FR", primaryCountry: "US", language: "fr" })).toBe("FR");
    expect(pickFirstCountry(list, { initialCountry: "JP", localeCountry: null, primaryCountry: "US", language: "fr" })).toBe("US");
  });

  it("French buyer, store shipping to the USA (and a few others), main-market lookup timed out: the USA, not « Algérie »", () => {
    const list = codes([{ countries: ["DZ", "MA", "US"] }]);
    expect(list[0]).toBe("DZ"); // the alphabetically first in French
    expect(pickFirstCountry(list, { initialCountry: "FR", localeCountry: null, primaryCountry: null, rateCountry: storeMarketOf([{ countries: ["DZ", "MA", "US"] }]), language: "fr" })).toBe("US");
  });

  it("a store with a dedicated USA rate and an international one: the USA, even without its orders", () => {
    const rates = [
      { countries: ["DZ", "MA", "TN", "CA", "GB", "US"], active: true },
      { countries: ["US"], active: true },
    ];
    const list = codes(rates);
    expect(pickFirstCountry(list, { initialCountry: "FR", primaryCountry: null, rateCountry: storeMarketOf(rates), language: "fr" })).toBe("US");
  });

  it("the main market (paid orders) beats the rate setup; the language's country beats the rate setup and the popular order", () => {
    const list = codes([{ countries: ["CA", "US", "FR"] }]);
    expect(pickFirstCountry(list, { primaryCountry: "CA", rateCountry: "US", language: "fr" })).toBe("CA");
    // A French checkout shipping to France: France, even with a dedicated USA rate.
    expect(pickFirstCountry(list, { rateCountry: "US", language: "fr" })).toBe("FR");
    // The language's country not shipped to: the rate setup's.
    expect(pickFirstCountry(list, { rateCountry: "US", language: "de" })).toBe("US");
    expect(pickFirstCountry(list, { language: "fr" })).toBe("FR");
    expect(pickFirstCountry(list, { language: "de" })).toBe("US");
  });

  it("English checkout: the USA by default (not the UK), and a dedicated rate beats the language", () => {
    const list = codes([{ countries: ["AU", "CA", "GB", "IE", "US"] }], "en");
    expect(LANG_COUNTRY.en).toBe("US");
    expect(pickFirstCountry(list, { language: "en" })).toBe("US");
    // A UK store (dedicated UK rate) in English: the UK, not the USA.
    expect(pickFirstCountry(list, { rateCountry: "GB", language: "en" })).toBe("GB");
    expect(pickFirstCountry(list, { rateCountry: "CA", language: "en" })).toBe("CA");
    // Stronger hints still win over the rate; the rate not shipped to: the language's country.
    expect(pickFirstCountry(list, { primaryCountry: "IE", rateCountry: "GB", language: "en" })).toBe("IE");
    expect(pickFirstCountry(list, { localeCountry: "AU", rateCountry: "GB", language: "en" })).toBe("AU");
    expect(pickFirstCountry(list, { rateCountry: "NZ", language: "en" })).toBe("US");
    // Other languages keep their own country before the rate.
    expect(pickFirstCountry(codes([{ countries: ["DE", "US"] }]), { rateCountry: "US", language: "de" })).toBe("DE");
  });

  it("hints the list doesn't hold are skipped; nothing known: the first popular market, else the first listed", () => {
    expect(pickFirstCountry(["DZ", "MA", "TN"], { initialCountry: "FR", primaryCountry: "BE", rateCountry: "DE", language: "fr" })).toBe("DZ");
    expect(pickFirstCountry(["DZ", "GB", "MA"], {})).toBe("GB");
    expect(pickFirstCountry([], {})).toBe("FR");
    expect(POPULAR_COUNTRIES[0]).toBe("US");
  });
});

describe("storeMarketOf: the store's market from its shipping setup", () => {
  it("the first active dedicated rate (one or two countries) in the merchant's order", () => {
    expect(storeMarketOf([{ countries: ["US"] }])).toBe("US");
    // The merchant's first rate wins, not the one with the fewest countries.
    expect(storeMarketOf([{ countries: ["FR", "BE"] }, { countries: ["CH"] }])).toBe("FR");
    expect(storeMarketOf([{ countries: ["FR", "BE"] }, { countries: ["DE", "AT"] }])).toBe("FR");
    expect(storeMarketOf([{ countries: ["US"], active: false }, { countries: ["CA"] }])).toBe("CA");
    // Order by position when given (whatever the list's order).
    expect(storeMarketOf([{ countries: ["CH"], position: 2 }, { countries: ["FR", "BE"], position: 0 }])).toBe("FR");
    // A wide rate first is skipped, the next dedicated one counts.
    expect(storeMarketOf([{ countries: ["AE", "AT", "DZ", "US"], position: 0 }, { countries: ["GB"], position: 1 }])).toBe("GB");
  });

  it("pickup rates are skipped (a relay network says little about who buys)", () => {
    expect(storeMarketOf([{ countries: ["BE"], kind: "pickup", position: 0 }, { countries: ["US"], kind: "home", position: 1 }])).toBe("US");
    expect(storeMarketOf([{ countries: ["BE"], kind: "pickup" }])).toBeNull();
  });

  it("none when every rate ships to many countries or everywhere (a long list's first code says nothing)", () => {
    expect(storeMarketOf([{ countries: ["AE", "AT", "DZ", "US"] }])).toBeNull();
    expect(storeMarketOf([{ countries: [] }])).toBeNull();
    expect(storeMarketOf([])).toBeNull();
  });
});

describe("countryHints / shipsToCountry", () => {
  it("a rate without countries ships to the default list", () => {
    expect(shipsToCountry([{ countries: [] }], "FR")).toBe(true);
    expect(shipsToCountry([{ countries: ["US"] }], "FR")).toBe(false);
    expect(countryHints([{ countries: ["US"] }], "FR", "fr-FR,fr;q=0.9")).toEqual({ served: false, localeCountry: null, needsPrimary: true });
    expect(countryHints([{ countries: ["US", "FR"] }], "DZ", "fr-FR")).toEqual({ served: false, localeCountry: "FR", needsPrimary: false });
  });
});
