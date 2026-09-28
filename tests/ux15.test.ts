import { describe, expect, it } from "vitest";
import { flashQuery, flashUrl, issueField } from "@/lib/flash";
import { flashBack } from "@/lib/flash-back";
import {
  DRAFT_TTL_MS,
  draftFields,
  draftForError,
  flashError,
  formSignature,
  freshDrafts,
  isStorable,
  mergeDrafts,
  parseDrafts,
  restorePlan,
  type ControlInfo,
  type FormDraft,
} from "@/components/dashboard/formDraft";
import { providerStatus } from "@/lib/provider-status";
import { humanizeError } from "@/lib/humanize-error";
import { formatCount, MAX_REVIEW_COUNT, parseCount, ratingScoreWarning } from "@/components/builder/decimal";
import { createBlock, ratingIsSet, type BlockOf } from "@/lib/layout";
import { parseMoney } from "@/components/dashboard/money";
import { inlineMessage } from "@/components/dashboard/formDraft";

/*
 * UX round 15: dashboard forms keep what was typed after a refused save (flash params with the
 * field at fault + the sessionStorage draft), the shared provider status (En panne), provider
 * access hints, and the rating block's score / review count fields.
 */

describe("flash URLs of server actions", () => {
  it("adds ok / error to the path, keeping an existing query and the hash", () => {
    expect(flashUrl("/d/s/offers", { ok: "Code créé" })).toBe("/d/s/offers?ok=Code+cr%C3%A9%C3%A9");
    expect(flashUrl("/d/s/analytics?tab=tests", { error: "Non" })).toBe("/d/s/analytics?tab=tests&error=Non");
    expect(flashUrl("/d/s/costs", { error: "Coût invalide", field: "cost" }, "#v-1")).toBe("/d/s/costs?error=Co%C3%BBt+invalide&field=cost#v-1");
    expect(flashUrl("/d/s/offers")).toBe("/d/s/offers");
    expect(flashUrl("/d/s/offers", {}, "#x")).toBe("/d/s/offers#x");
  });

  it("names the field (and the batch section) only next to an error", () => {
    expect(Object.fromEntries(flashQuery({ error: "Pourcentage entier entre 1 et 100", field: "value" }))).toEqual({ error: "Pourcentage entier entre 1 et 100", field: "value" });
    expect(Object.fromEntries(flashQuery({ ok: "Enregistré", field: "value", form: "Alertes" }))).toEqual({ ok: "Enregistré" });
    expect(Object.fromEntries(flashQuery({ error: "Alertes : E-mail invalide", field: "alertEmail", form: "Alertes" }))).toEqual({
      error: "Alertes : E-mail invalide",
      field: "alertEmail",
      form: "Alertes",
    });
  });

  it("takes the field of the first zod issue", () => {
    expect(issueField([{ path: ["code"] }, { path: ["value"] }])).toBe("code");
    expect(issueField([{ path: [] }])).toBeUndefined();
    expect(issueField([{ path: [0] }])).toBeUndefined();
    expect(issueField(undefined)).toBeUndefined();
  });

  it("drops a previous field / form flash when a form returns to the same page", () => {
    const back = "/d/s/analytics?tab=tests&error=Old&field=tiers&form=X&range=30d";
    expect(flashBack(back, "/d/s/analytics", "/d/s/analytics", { ok: "Test lancé" })).toBe("/d/s/analytics?tab=tests&range=30d&ok=Test+lanc%C3%A9");
    expect(flashBack(back, "/d/s/analytics", "/d/s/analytics", { error: "Paliers B illisibles", field: "tiers" })).toBe("/d/s/analytics?tab=tests&range=30d&error=Paliers+B+illisibles&field=tiers");
  });
});

const ctl = (name: string, value: string, type = "text", checked?: boolean): ControlInfo => ({ name, value, type, checked });

describe("form drafts (typed values kept across a refused save)", () => {
  it("never stores secrets, files, hidden plumbing or disabled fields", () => {
    expect(isStorable(ctl("code", "PROMO"))).toBe(true);
    expect(isStorable(ctl("apiKey", "sk_live"))).toBe(false);
    expect(isStorable(ctl("clientSecret", "x"))).toBe(false);
    expect(isStorable(ctl("metaAccessToken", "x"))).toBe(false);
    expect(isStorable(ctl("mondialRelayKey", "x"))).toBe(false);
    expect(isStorable(ctl("operatorResendApiKey", "re_x"))).toBe(false);
    expect(isStorable(ctl("password", "x", "password"))).toBe(false);
    expect(isStorable(ctl("id", "abc", "hidden"))).toBe(false);
    expect(isStorable(ctl("file", "", "file"))).toBe(false);
    expect(isStorable(ctl("$ACTION_ID_abc", ""))).toBe(false);
    expect(isStorable({ ...ctl("name", "x"), noDraft: true })).toBe(false);
  });

  it("keeps text values and checkbox states", () => {
    const fields = draftFields([ctl("code", "UX15"), ctl("type", "PERCENT", "select"), ctl("combinesWithBreaks", "on", "checkbox", false), ctl("id", "1", "hidden")]);
    expect(fields).toEqual([
      { name: "code", value: "UX15" },
      { name: "type", value: "PERCENT" },
      { name: "combinesWithBreaks", value: "on", checked: false },
    ]);
  });

  it("identifies a form by its field names, in any order", () => {
    expect(formSignature(["value", "code", "type", "code", "$ACTION_KEY"])).toBe("code|type|value");
    expect(formSignature(["b", "a"])).toBe(formSignature(["a", "b"]));
  });

  const draft = (over: Partial<FormDraft> = {}): FormDraft => ({ path: "/d/s/offers", sig: "code|type|value", index: 0, fields: [{ name: "value", value: "12,5" }], at: 1_000, ...over });

  it("parses storage defensively", () => {
    expect(parseDrafts(null)).toEqual([]);
    expect(parseDrafts("not json")).toEqual([]);
    expect(parseDrafts('{"a":1}')).toEqual([]);
    expect(parseDrafts(JSON.stringify([draft(), { path: "/x" }]))).toEqual([draft()]);
  });

  it("only restores fresh drafts of the same page", () => {
    const d = [draft(), draft({ path: "/d/s/shipping" }), draft({ at: 1_000 - DRAFT_TTL_MS - 1 })];
    expect(freshDrafts(d, "/d/s/offers", 1_000 + 5_000)).toEqual([draft()]);
    expect(freshDrafts(d, "/d/s/offers", 1_000 + DRAFT_TTL_MS + 1)).toEqual([]);
  });

  it("replaces the draft of the same form and drops stale ones", () => {
    const old = draft({ fields: [{ name: "value", value: "1" }] });
    const other = draft({ index: 1 });
    const stale = draft({ sig: "x", at: -DRAFT_TTL_MS * 2 });
    const next = draft({ at: 2_000, fields: [{ name: "value", value: "150" }] });
    expect(mergeDrafts([old, other, stale], [next], 2_000)).toEqual([other, next]);
  });

  it("reads the error flash of the returned page", () => {
    expect(flashError("?ok=Enregistré")).toBeNull();
    expect(flashError("?error=Pourcentage+entier+entre+1+et+100&field=value")).toEqual({ error: "Pourcentage entier entre 1 et 100", fields: ["value"], form: undefined });
    expect(flashError(new URLSearchParams({ error: "x", field: "startsAt, endsAt", form: "Alertes" }))).toEqual({ error: "x", fields: ["startsAt", "endsAt"], form: "Alertes" });
    expect(flashError("?error=Whop+a+refus%C3%A9")).toEqual({ error: "Whop a refusé", fields: [], form: undefined });
  });

  it("picks the form named by the batch save, else the last one submitted", () => {
    const a = draft({ label: "Marges & coûts", at: 1 });
    const b = draft({ label: "Alertes", at: 2 });
    expect(draftForError([a, b])).toBe(b);
    expect(draftForError([a, b], "Marges & coûts")).toBe(a);
    expect(draftForError([a, b], "Inconnu")).toBe(b);
    expect(draftForError([])).toBeNull();
  });

  it("plans the values to put back: same-name fields by rank, checkboxes by value, unchanged ones skipped", () => {
    const controls = [
      ctl("code", ""),
      ctl("type", "PERCENT", "select"),
      ctl("value", "10"),
      ctl("id", "row1", "hidden"),
      ctl("ruleCountries", "FR", "checkbox", false),
      ctl("ruleCountries", "BE", "checkbox", true),
      ctl("tier", "a"),
      ctl("tier", "b"),
    ];
    const fields = [
      { name: "code", value: "UX15FIX" },
      { name: "type", value: "PERCENT" },
      { name: "value", value: "12,5" },
      { name: "ruleCountries", value: "FR", checked: true },
      { name: "ruleCountries", value: "BE", checked: true },
      { name: "tier", value: "a" },
      { name: "tier", value: "c" },
    ];
    expect(restorePlan(controls, fields)).toEqual([
      { index: 0, value: "UX15FIX" },
      { index: 2, value: "12,5" },
      { index: 4, checked: true },
      { index: 7, value: "c" },
    ]);
  });
});

describe("no silent rounding of typed amounts", () => {
  it("MoneyInput leaves a third decimal as typed (the server refuses it) instead of rounding", () => {
    expect(parseMoney("2,99")).toBe(299);
    expect(parseMoney("1 234,5")).toBe(123450);
    expect(parseMoney("12")).toBe(1200);
    expect(parseMoney("2,999")).toBeNull();
    expect(parseMoney("4.905")).toBeNull();
    expect(parseMoney(",")).toBeNull();
    expect(parseMoney("1e3")).toBeNull();
  });

  it("shows the section's own error next to the field of a batch save", () => {
    expect(inlineMessage("Alertes : E-mail d'alerte invalide (déjà enregistré : Marges & coûts)", "Alertes")).toBe("E-mail d'alerte invalide");
    expect(inlineMessage("Alertes : E-mail d'alerte invalide", "Alertes")).toBe("E-mail d'alerte invalide");
    expect(inlineMessage("Prix invalide", undefined)).toBe("Prix invalide");
  });
});

describe("provider status (Services externes card and sidebar dots)", () => {
  const day = (calls: number, errors: number, lastOkAt: Date | null = new Date()) => ({ calls, errors, lastOkAt });

  it("is down when every call of the hour failed (3 calls or more)", () => {
    const s = providerStatus({ hour: { calls: 3, errors: 3, degraded: null }, day: day(40, 3) });
    expect(s).toMatchObject({ level: "down", label: "En panne", color: "red" });
    expect(s.reason).toContain("3 appels");
    // Two failed calls: not enough to call it down.
    expect(providerStatus({ hour: { calls: 2, errors: 2, degraded: null }, day: day(40, 2) })).toMatchObject({ level: "watch", color: "amber" });
  });

  it("is down when calls were made without a single success in 24 h", () => {
    const s = providerStatus({ hour: null, day: day(5, 5, null) });
    expect(s).toMatchObject({ level: "down", color: "red" });
    expect(s.reason).toBe("aucun succès sur 24 h (5 appels, 5 erreurs)");
  });

  it("keeps the degraded / watch / idle / ok levels", () => {
    expect(providerStatus({ hour: { calls: 20, errors: 6, degraded: "30 % d'erreurs sur 20 appels" }, day: day(100, 6) })).toMatchObject({ level: "degraded", label: "Dégradé" });
    expect(providerStatus({ hour: { calls: 4, errors: 1, degraded: null }, day: day(100, 1) })).toMatchObject({ level: "watch", label: "À surveiller" });
    expect(providerStatus({ hour: null, day: day(10, 0) })).toMatchObject({ level: "idle", color: "zinc" });
    expect(providerStatus({ hour: { calls: 10, errors: 0, degraded: null }, day: day(10, 0) })).toMatchObject({ level: "ok", color: "green" });
  });
});

describe("provider access errors", () => {
  it("never tells to check a key for a keyless provider", () => {
    const ecb = humanizeError("HTTP 403", { provider: "ecb" });
    expect(ecb.text).not.toMatch(/clé API ou jeton/);
    expect(ecb.text).toMatch(/aucune clé/);
    expect(ecb.detail).toBe("HTTP 403");
    expect(humanizeError("cart.js 403 Forbidden").text).toMatch(/Aucune clé n'est en cause/);
  });

  it("names what to check for each provider", () => {
    expect(humanizeError("HTTP 401", { provider: "mondial_relay" }).text).toMatch(/code enseigne et la clé privée/);
    expect(humanizeError("HTTP 403", { provider: "whop" }).text).toMatch(/clé API Whop/);
    expect(humanizeError("HTTP 401", { provider: "resend" }).text).toMatch(/clé Resend/);
    // Without a provider the generic wording stays.
    expect(humanizeError("HTTP 403").text).toMatch(/clé API ou jeton/);
    // Other errors keep their rules.
    expect(humanizeError("HTTP 503", { provider: "ecb" }).text).toMatch(/momentanément indisponible/);
  });
});

describe("rating block fields", () => {
  it("accepts review counts grouped by spaces", () => {
    expect(parseCount("1 250")).toEqual({ kind: "ok", value: 1250 });
    expect(parseCount("1 250")).toEqual({ kind: "ok", value: 1250 });
    expect(parseCount("12 500")).toEqual({ kind: "ok", value: 12500 });
    expect(parseCount(" 1250 ")).toEqual({ kind: "ok", value: 1250 });
    expect(parseCount("1 234 567")).toEqual({ kind: "ok", value: 1234567 });
    expect(parseCount("0")).toEqual({ kind: "ok", value: 0 });
    expect(parseCount("")).toEqual({ kind: "empty" });
  });

  it("refuses anything but digits", () => {
    for (const bad of ["1,5", "1.250", "abc", "-3", "12 50", "1e3", "+4"]) expect(parseCount(bad)).toEqual({ kind: "invalid" });
    expect(parseCount("20 000 000", { max: MAX_REVIEW_COUNT })).toEqual({ kind: "range", value: 20_000_000 });
  });

  it("formats counts with spaces", () => {
    expect(formatCount(1250)).toBe("1 250");
    expect(formatCount(1234567)).toBe("1 234 567");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(null)).toBe("");
  });

  it("warns below 3,5 and treats 0 as no rating", () => {
    expect(ratingScoreWarning(3.4)).toMatch(/Une note basse peut freiner l'achat/);
    expect(ratingScoreWarning(1)).toMatch(/freiner/);
    expect(ratingScoreWarning(3.5)).toBeNull();
    expect(ratingScoreWarning(4.8)).toBeNull();
    expect(ratingScoreWarning(null)).toBeNull();
    expect(ratingScoreWarning(0)).toBeNull();
    const b = createBlock("rating") as BlockOf<"rating">;
    expect(ratingIsSet({ ...b.props, score: 0 })).toBe(false);
    expect(ratingIsSet({ ...b.props, score: 1 })).toBe(true);
  });
});
