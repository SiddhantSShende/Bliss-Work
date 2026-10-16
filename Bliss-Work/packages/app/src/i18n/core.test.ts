import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInstance } from "i18next";
import {
  LOCALE_STORAGE_KEY,
  applyDocumentLanguage,
  buildInitOptions,
  persistLocale,
  readStoredLocale,
  resolveLocale,
} from "./core";
import { DEFAULT_LOCALE, LOCALES, matchLocale } from "./locales";

describe("locale registry", () => {
  it("ships exactly the nine approved languages, English first", () => {
    expect(LOCALES.map((l) => l.code)).toEqual(["en", "es", "fr", "de", "hi", "pt", "ja", "zh", "ko"]);
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("has a native name for every locale and no duplicate codes", () => {
    expect(new Set(LOCALES.map((l) => l.code)).size).toBe(LOCALES.length);
    for (const l of LOCALES) expect(l.nativeName.length).toBeGreaterThan(0);
  });

});

describe("matchLocale", () => {
  it.each([
    ["en", "en"],
    ["EN", "en"],
    ["es-MX", "es"],
    ["es_AR", "es"],
    ["pt-BR", "pt"],
    ["pt-PT", "pt"],
    ["zh-CN", "zh"],
    ["zh-Hans", "zh"],
    ["ja-JP", "ja"],
    ["ko-KR", "ko"],
    ["hi-IN", "hi"],
  ])("maps %s to %s", (tag, expected) => {
    expect(matchLocale(tag)).toBe(expected);
  });

  it.each(["ru", "ar-EG", "xx", "", "   ", "not a locale!"])("rejects unsupported %j", (tag) => {
    expect(matchLocale(tag)).toBeNull();
  });

  it.each(["zh-TW", "zh-HK", "zh-Hant", "zh-Hant-TW", "zh_MO"])(
    "does not map Traditional Chinese %s onto the Simplified catalog",
    (tag) => {
      expect(matchLocale(tag)).toBeNull();
    },
  );

  it("tolerates non-string input", () => {
    expect(matchLocale(undefined)).toBeNull();
    expect(matchLocale(null)).toBeNull();
    expect(matchLocale(42 as unknown as string)).toBeNull();
  });
});

describe("resolveLocale precedence", () => {
  it("prefers a valid persisted choice over the system language", () => {
    expect(resolveLocale("de", ["fr-FR"])).toBe("de");
  });

  it("lets an explicit English choice beat a non-English system language", () => {
    expect(resolveLocale("en", ["ja-JP"])).toBe("en");
  });

  it("falls to the first supported system language when nothing is persisted", () => {
    expect(resolveLocale(null, ["ru-RU", "pt-BR", "en"])).toBe("pt");
  });

  it("ignores an invalid persisted value and uses the system language", () => {
    expect(resolveLocale("klingon", ["ko-KR"])).toBe("ko");
  });

  it("falls back to English when nothing matches", () => {
    expect(resolveLocale(null, ["ru-RU", "ar-EG"])).toBe("en");
    expect(resolveLocale(undefined, [])).toBe("en");
  });
});

describe("persisted locale", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("round-trips an explicit choice under the long-standing tb-locale key", () => {
    persistLocale("ja");
    expect(localStorage.getItem("tb-locale")).toBe("ja");
    expect(LOCALE_STORAGE_KEY).toBe("tb-locale");
    expect(readStoredLocale()).toBe("ja");
  });

  it("returns null when nothing is stored", () => {
    expect(readStoredLocale()).toBeNull();
  });

  it("migrates a regional code stored by an older build (pt-BR → pt)", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "pt-BR");
    expect(readStoredLocale()).toBe("pt");
  });

  it("drops an invalid stored value so it cannot shadow the system language", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "xx-garbage");
    expect(readStoredLocale()).toBeNull();
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
  });

  it("survives unavailable storage (private mode)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readStoredLocale()).toBeNull();
    expect(() => persistLocale("es")).not.toThrow();
  });
});

describe("applyDocumentLanguage", () => {
  it("sets <html lang> and dir", () => {
    applyDocumentLanguage("ja");
    expect(document.documentElement.lang).toBe("ja");
    expect(document.documentElement.dir).toBe("ltr");
    applyDocumentLanguage("en");
    expect(document.documentElement.lang).toBe("en");
  });
});

describe("buildInitOptions: English fallback", () => {
  const english = { common: { hello: "Hello", items_one: "{{count}} item", items_other: "{{count}} items" } };

  it("routes development missing-key diagnostics through the configured logger", () => {
    const warn = vi.fn();
    const options = buildInitOptions(english, { dev: true, warn });

    const missingKeyHandler = options.missingKeyHandler;
    expect(typeof missingKeyHandler).toBe("function");
    if (typeof missingKeyHandler === "function") {
      missingKeyHandler(["en"], "common", "missing", "missing", false, {});
    }

    expect(warn).toHaveBeenCalledWith('[i18n] missing key "common:missing" for locale(s)', ["en"]);
  });

  async function make(extra?: Record<string, Record<string, object>>) {
    const inst = createInstance();
    await inst.init(buildInitOptions(english));
    for (const [lng, namespaces] of Object.entries(extra ?? {})) {
      for (const [ns, res] of Object.entries(namespaces)) inst.addResourceBundle(lng, ns, res, true, true);
    }
    return inst;
  }

  it("falls back to the English string for a key missing in the active locale", async () => {
    const inst = await make({ es: { common: {} } });
    await inst.changeLanguage("es");
    expect(inst.t("common:hello")).toBe("Hello");
  });

  it("falls back to English when the locale has no resources at all", async () => {
    const inst = await make();
    await inst.changeLanguage("ja");
    expect(inst.t("common:hello")).toBe("Hello");
  });

  it("uses the translation when present", async () => {
    const inst = await make({ es: { common: { hello: "Hola" } } });
    await inst.changeLanguage("es");
    expect(inst.t("common:hello")).toBe("Hola");
  });

  it("interpolates and pluralises per locale", async () => {
    const inst = await make({
      ja: { common: { items_other: "{{count}}件" } },
      es: { common: { items_one: "{{count}} elemento", items_other: "{{count}} elementos" } },
    });
    await inst.changeLanguage("es");
    expect(inst.t("common:items", { count: 1 })).toBe("1 elemento");
    expect(inst.t("common:items", { count: 3 })).toBe("3 elementos");
    await inst.changeLanguage("ja");
    expect(inst.t("common:items", { count: 1 })).toBe("1件");
  });

  it("supports exactly the registry's locales", async () => {
    const inst = await make();
    expect(inst.options.supportedLngs).toEqual(expect.arrayContaining(LOCALES.map((l) => l.code)));
  });
});
