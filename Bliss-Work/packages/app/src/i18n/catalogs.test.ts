/**
 * The real catalogs, through the real lazy loader, for every registered locale.
 * scripts/check-locales.mjs proves the files mirror English structurally; this
 * proves the running app can actually load and render them: namespaces register,
 * the language really changes the output, every key renders without an
 * unresolved `{{placeholder}}` or a raw key, and every plural form resolves for
 * representative counts.
 */
import { afterAll, describe, expect, it } from "vitest";
import i18n from "./index";
import { NAMESPACES } from "./index";
import { ensureLocaleLoaded } from "./catalogs";
import { LOCALES } from "./locales";

const NON_ENGLISH = LOCALES.filter((l) => l.code !== "en").map((l) => l.code);
const COUNTS = [0, 1, 2, 5, 21, 1_000_000];

/** Every leaf of an English namespace as [dotted key, value]. */
function leaves(obj: object, prefix = ""): [string, string][] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v !== null && typeof v === "object" ? leaves(v as object, `${prefix}${k}.`) : [[`${prefix}${k}`, String(v)] as [string, string]],
  );
}

/** Plural-suffixed keys collapse to their base (`a.b_one`/`a.b_other` → `a.b`). */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]!);
}

afterAll(async () => {
  await i18n.changeLanguage("en");
});

describe("English source", () => {
  it("registers every namespace", () => {
    expect(NAMESPACES.length).toBeGreaterThanOrEqual(19);
    expect(NAMESPACES).toEqual(expect.arrayContaining(["common", "desktop", "meetings", "tasks"]));
  });
});

describe.each(NON_ENGLISH)("locale %s", (code) => {
  it("loads every namespace through the lazy loader", async () => {
    await ensureLocaleLoaded(i18n, code);
    for (const ns of NAMESPACES) {
      expect(i18n.hasResourceBundle(code, ns), `${code}:${ns}`).toBe(true);
    }
  });

  it("is idempotent", async () => {
    await ensureLocaleLoaded(i18n, code);
    await expect(ensureLocaleLoaded(i18n, code)).resolves.toBeUndefined();
  });

  it("actually translates (differs from English) and keeps the brand", async () => {
    await ensureLocaleLoaded(i18n, code);
    await i18n.changeLanguage("en");
    const english = i18n.t("common:buttons.save");
    await i18n.changeLanguage(code);
    expect(i18n.t("common:buttons.save")).not.toBe(english);
    expect(i18n.t("desktop:tray.show")).toContain("BlissWork");
    await i18n.changeLanguage("en");
  });

  it("renders every key without unresolved placeholders or raw keys", async () => {
    await ensureLocaleLoaded(i18n, code);
    const t = i18n.getFixedT(code);
    const bad: string[] = [];
    for (const ns of NAMESPACES) {
      const en = i18n.getResourceBundle("en", ns) as object;
      const seen = new Set<string>();
      for (const [key, value] of leaves(en)) {
        const base = key.replace(PLURAL_SUFFIX, "");
        const isPlural = base !== key;
        if (isPlural && seen.has(base)) continue;
        seen.add(base);
        const params: Record<string, string> = Object.fromEntries(placeholdersOf(value).map((p) => [p, "§"]));
        const counts = isPlural ? COUNTS : [undefined];
        for (const count of counts) {
          const out = t(`${ns}:${isPlural ? base : key}`, { ...params, ...(count === undefined ? {} : { count }) }) as string;
          if (out.includes("{{") || out.includes("}}") || out === `${isPlural ? base : key}` || out.trim() === "") {
            bad.push(`${ns}:${base}${count === undefined ? "" : `@${count}`} -> ${JSON.stringify(out)}`);
          }
        }
      }
    }
    expect(bad.slice(0, 20)).toEqual([]);
  });
});
