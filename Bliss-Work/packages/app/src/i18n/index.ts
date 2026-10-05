import i18n from "i18next";
import { initReactI18next } from "react-i18next";

/**
 * Locales this build ships catalogs for. Only English is bundled — every
 * other locale is fetched at runtime from BlissWork's own backend (which
 * calls Google Cloud Translation server-side; the client never holds that
 * credential and never calls Google directly). This constant will grow once
 * that dynamic-fetch path exists; for now it is exactly what the app ships.
 */
export const AVAILABLE_LOCALES = ["en"] as const;
export type Locale = (typeof AVAILABLE_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

// English is statically imported (via Vite's `import.meta.glob(..., { eager:
// true })`, which still bundles every file at build time — this is not a
// runtime fetch) so the app always has a working UI with zero network
// dependency, even before any other locale can be fetched.
//
// One namespace = one JSON file under locales/en/. Adding a new namespace is
// just adding the file — nothing here needs editing, which matters now that
// there are a dozen-plus of them.
// `import.meta.glob` is a Vite build-time macro (statically expanded into an
// import per matched file — still fully bundled, not a runtime fetch). Cast
// for the same reason as `isDev` below: this shared package's tsconfig
// deliberately excludes vite/client types (see lib/buildInfo.ts).
type ImportMetaGlob = { glob: (pattern: string, opts: { eager: true }) => Record<string, { default: object }> };

function loadEnglishResources(): Record<string, object> {
  const modules = (import.meta as unknown as ImportMetaGlob).glob("./locales/en/*.json", { eager: true });
  const out: Record<string, object> = {};
  const prefix = "./locales/en/";
  for (const [path, mod] of Object.entries(modules)) {
    const ns = path.slice(prefix.length).replace(/\.json$/, "");
    out[ns] = mod.default;
  }
  return out;
}

const enResources = loadEnglishResources();

export const NAMESPACES = Object.keys(enResources);

// `import.meta.env` is Vite's build-time env (statically replaced). packages/app
// is consumed by both the web + electron Vite builds; cast so this compiles
// without pulling vite/client types into this shared package's tsconfig — same
// pattern as lib/buildInfo.ts.
const isDev =
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;

void i18n.use(initReactI18next).init({
  resources: { en: enResources },
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  defaultNS: "common",
  ns: NAMESPACES,
  interpolation: { escapeValue: false }, // React already escapes rendered output
  returnNull: false,
  // A key missing from a locale fetched at runtime (not yet translated, or
  // added since that fetch ran) falls back to the English string above —
  // never a blank string or a raw key. Also covers every key today, since no
  // other locale's resources are loaded yet.
  saveMissing: isDev,
  missingKeyHandler: isDev
    ? (langs, ns, key) => console.warn(`[i18n] missing key "${ns}:${key}" for locale(s)`, langs)
    : undefined,
});

export default i18n;
