import type { i18n as I18nInstance } from "i18next";
import { DEFAULT_LOCALE } from "./locales";

/**
 * Catalog loading (Vite only — `import.meta.glob` is a build-time macro).
 *
 * English is bundled eagerly: the app always has a complete UI with no network.
 * Every other locale is one lazy chunk per namespace, emitted under /assets/
 * with a content hash (immutable-cached by nginx/Caddy) and fetched only when
 * that language is selected. In the Electron build the same chunks sit inside
 * the asar, so it works fully offline.
 *
 * Cast because this shared package's tsconfig deliberately excludes vite/client
 * types (same pattern as lib/buildInfo.ts). The cast must stay INLINE at each
 * call: Vite only rewrites a literal `import.meta.glob(...)` expression, so
 * aliasing `import.meta` to a variable breaks the build-time expansion.
 */
type Glob = {
  glob: {
    (patterns: string | string[], opts: { eager: true; import: "default" }): Record<string, object>;
    (patterns: string | string[], opts: { import: "default" }): Record<string, () => Promise<object>>;
  };
};

function namespaceOf(path: string, dir: string): string {
  return path.slice(`./locales/${dir}/`.length).replace(/\.json$/, "");
}

/** namespace → English catalog. */
export const englishResources: Record<string, object> = Object.fromEntries(
  Object.entries(
    (import.meta as unknown as Glob).glob("./locales/en/*.json", { eager: true, import: "default" }),
  ).map(([path, mod]) => [namespaceOf(path, "en"), mod]),
);

const lazyCatalogs = (import.meta as unknown as Glob).glob(["./locales/*/*.json", "!./locales/en/*.json"], {
  import: "default",
});

const loaded = new Set<string>();

/**
 * Load every namespace of `locale` into `instance`. Resolves once all are
 * registered; rejects if the locale has no catalog or any chunk fails (offline,
 * CDN error) — callers decide how to degrade. Idempotent.
 */
export async function ensureLocaleLoaded(instance: I18nInstance, locale: string): Promise<void> {
  if (locale === DEFAULT_LOCALE || loaded.has(locale)) return;
  const entries = Object.entries(lazyCatalogs).filter(([path]) => path.startsWith(`./locales/${locale}/`));
  if (entries.length === 0) throw new Error(`[i18n] no catalog for locale "${locale}"`);
  await Promise.all(
    entries.map(async ([path, load]) => {
      instance.addResourceBundle(locale, namespaceOf(path, locale), await load(), true, true);
    }),
  );
  loaded.add(locale);
}
