import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, LOCALES, SELECTABLE_LOCALES, selectableLocales } from "./locales";

// The release gate: a locale whose catalog no fluent speaker has reviewed stays
// `ready: false`, which hides it from users in production builds. Development
// builds (and therefore vitest) preview everything so reviewers can use them.
describe("release gate", () => {
  it("English is always ready — it is the default and the fallback", () => {
    const en = LOCALES.find((l) => l.code === DEFAULT_LOCALE);
    expect(en?.ready).toBe(true);
  });

  it("production: only ready locales are selectable or matched", () => {
    const prod = selectableLocales(LOCALES, false);
    expect(prod.every((l) => l.ready)).toBe(true);
    expect(prod.map((l) => l.code)).toContain("en");
    for (const l of LOCALES.filter((x) => !x.ready)) {
      expect(prod.map((p) => p.code)).not.toContain(l.code);
    }
  });

  it("development: every locale is previewable, English first", () => {
    const dev = selectableLocales(LOCALES, true);
    expect(dev.map((l) => l.code)).toEqual(LOCALES.map((l) => l.code));
    expect(dev[0]?.code).toBe("en");
  });

  // Regression: the gate once left every locale but English `ready: false`, so the
  // production selector showed only English while dev builds (and vitest, which
  // runs with DEV on) showed all nine. Assert the PRODUCTION list itself.
  it("production: all nine languages are selectable — the gate hides none of them", () => {
    expect(selectableLocales(LOCALES, false).map((l) => l.code)).toEqual(LOCALES.map((l) => l.code));
    expect(LOCALES.filter((l) => !l.ready).map((l) => l.code)).toEqual([]);
    expect(LOCALES).toHaveLength(9);
  });

  it("the exported list is the dev preview under vitest (a dev environment)", () => {
    expect(SELECTABLE_LOCALES.map((l) => l.code)).toEqual(LOCALES.map((l) => l.code));
  });

  it("a locale hidden by the gate is not matched from a stored/system language", () => {
    const hidden = [{ code: "xx", englishName: "X", nativeName: "X", dir: "ltr", ready: false }] as const;
    expect(selectableLocales(hidden, false)).toEqual([]);
  });
});
