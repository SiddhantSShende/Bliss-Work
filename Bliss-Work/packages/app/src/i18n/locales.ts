/**
 * The ONE list of UI languages. The selector, the persisted-locale check, the
 * system-language match, i18next's `supportedLngs`, the `<html lang/dir>`
 * update and scripts/check-locales.mjs all derive from this — add a language
 * here and add `locales/<code>/` (the check fails until the catalog is
 * complete).
 *
 * React-free and dependency-free on purpose: the Electron main process imports
 * it too (menu, tray, notifications).
 */
export interface LocaleInfo {
  /** Catalog directory name under `locales/`; also the BCP-47 primary subtag. */
  code: string;
  englishName: string;
  /** Always shown in its own language — never translated, so a user who cannot
   *  read the current UI language can still find theirs. */
  nativeName: string;
  dir: "ltr" | "rtl";
  /** Release gate. `false` keeps a locale out of the selector and out of
   *  persisted/system-language resolution in PRODUCTION builds — the catalog exists
   *  and is validated, but no fluent speaker has reviewed it yet. Flip to `true`
   *  per language once someone has signed it off. Development builds
   *  (`import.meta.env.DEV`) expose every locale so reviewers can use them. */
  ready: boolean;
}

export const LOCALES = [
  { code: "en", englishName: "English", nativeName: "English", dir: "ltr", ready: true },
  { code: "es", englishName: "Spanish", nativeName: "Español", dir: "ltr", ready: false },
  { code: "fr", englishName: "French", nativeName: "Français", dir: "ltr", ready: false },
  { code: "de", englishName: "German", nativeName: "Deutsch", dir: "ltr", ready: false },
  { code: "hi", englishName: "Hindi", nativeName: "हिन्दी", dir: "ltr", ready: false },
  // Brazilian Portuguese wording.
  { code: "pt", englishName: "Portuguese", nativeName: "Português", dir: "ltr", ready: false },
  { code: "ja", englishName: "Japanese", nativeName: "日本語", dir: "ltr", ready: false },
  // Simplified Chinese. Traditional (zh-TW / zh-HK) is a separate future locale.
  { code: "zh", englishName: "Chinese (Simplified)", nativeName: "简体中文", dir: "ltr", ready: false },
  { code: "ko", englishName: "Korean", nativeName: "한국어", dir: "ltr", ready: false },
] as const satisfies readonly LocaleInfo[];

export type Locale = (typeof LOCALES)[number]["code"];
export const DEFAULT_LOCALE: Locale = "en";

/** The locales a user may pick or be matched to: the `ready` ones, or all of them
 *  when `preview` is on (development builds). Pure so both branches are testable. */
export function selectableLocales(all: readonly LocaleInfo[], preview: boolean): readonly LocaleInfo[] {
  return preview ? all : all.filter((l) => l.ready);
}

// `import.meta.env` is Vite's build-time env, statically replaced; cast so this
// compiles in packages whose tsconfig excludes vite/client (same pattern as
// lib/buildInfo.ts). Absent (plain Node) means "not a dev build".
const PREVIEW_ALL =
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;

export const SELECTABLE_LOCALES: readonly LocaleInfo[] = selectableLocales(LOCALES, PREVIEW_ALL);

export function localeInfo(code: string): LocaleInfo | undefined {
  return LOCALES.find((l) => l.code === code);
}

// Traditional-script tags must not silently land on the Simplified catalog.
const TRADITIONAL_CHINESE = /^zh[-_](hant|tw|hk|mo)\b/i;

/**
 * Map any BCP-47-ish tag ("pt-BR", "es_MX", "zh-CN", "EN") to a selectable
 * locale code, or null when we do not ship it.
 */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag || typeof tag !== "string") return null;
  if (TRADITIONAL_CHINESE.test(tag)) return null;
  const primary = tag.trim().split(/[-_]/)[0]?.toLowerCase();
  const hit = SELECTABLE_LOCALES.find((l) => l.code === primary);
  return hit ? (hit.code as Locale) : null;
}
