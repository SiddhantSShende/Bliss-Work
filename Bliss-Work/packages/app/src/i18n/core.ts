import type { InitOptions } from "i18next";
import { DEFAULT_LOCALE, LOCALES, localeInfo, matchLocale, type Locale } from "./locales";

/**
 * React-free, Vite-free i18n core, shared by the app renderer (index.ts) and the
 * Electron main process (apps/desktop/src/main/i18n.ts). Anything that touches
 * `import.meta.glob` lives in catalogs.ts instead so this file stays importable
 * from a plain Node/Electron-main bundle.
 */

/** Persisted explicit choice. Same key the app has always used, so existing
 *  users keep their selection. */
export const LOCALE_STORAGE_KEY = "tb-locale";

/** Locale to use right now: a valid persisted choice, else the first system
 *  language we ship, else English. An explicit "en" beats the system language. */
export function resolveLocale(stored: string | null | undefined, systemLanguages: readonly string[]): Locale {
  const fromStore = matchLocale(stored);
  if (fromStore) return fromStore;
  for (const tag of systemLanguages) {
    const hit = matchLocale(tag);
    if (hit) return hit;
  }
  return DEFAULT_LOCALE;
}

/** The persisted choice, or null when absent, unreadable, or no longer a locale
 *  we ship. An invalid value is removed so it cannot shadow the system language. */
export function readStoredLocale(): Locale | null {
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw === null) return null;
    const hit = matchLocale(raw);
    if (!hit) localStorage.removeItem(LOCALE_STORAGE_KEY);
    return hit;
  } catch {
    return null; // storage unavailable (private mode / blocked)
  }
}

export function persistLocale(locale: string): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // The choice still applies for this session.
  }
}

export function systemLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

/** Keep `<html lang dir>` in step with the active language (assistive tech,
 *  hyphenation, CJK font selection, future RTL). */
export function applyDocumentLanguage(locale: string): void {
  if (typeof document === "undefined") return;
  const info = localeInfo(locale);
  document.documentElement.lang = locale;
  document.documentElement.dir = info?.dir ?? "ltr";
}

/**
 * i18next options shared by every runtime. `resources` carries only English —
 * it is always present, so a missing key, a missing namespace or a locale that
 * failed to load all degrade to English instead of showing a raw key.
 */
export function buildInitOptions(
  english: Record<string, object>,
  opts: { dev?: boolean } = {},
): InitOptions {
  return {
    resources: { en: english },
    lng: DEFAULT_LOCALE,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: LOCALES.map((l) => l.code),
    load: "languageOnly",
    defaultNS: "common",
    ns: Object.keys(english),
    interpolation: { escapeValue: false }, // React already escapes rendered output
    returnNull: false,
    saveMissing: opts.dev === true,
    missingKeyHandler: opts.dev
      ? (langs, ns, key) => console.warn(`[i18n] missing key "${ns}:${key}" for locale(s)`, langs)
      : undefined,
  };
}
