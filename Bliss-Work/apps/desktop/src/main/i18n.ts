import { createInstance, type TOptions } from "i18next";
import { buildInitOptions, resolveLocale } from "@taskboard/app/i18n/core";
import { DEFAULT_LOCALE, matchLocale, type Locale } from "@taskboard/app/i18n/locales";

/**
 * Localized strings for the Electron MAIN process — application menu, tray,
 * OS notifications, update/attachment dialogs. The renderer has its own i18next
 * instance; this is a second one in a separate process, fed from the SAME
 * catalog files (`desktop` namespace in packages/app/src/i18n/locales/<lng>/),
 * so keys and wording cannot diverge between the two.
 *
 * Deliberately Electron-free (the caller supplies the system locale and the
 * persisted one) so it is unit-testable in plain Node. The catalogs are tiny, so
 * every locale's `desktop.json` is bundled eagerly: switching language never
 * touches the disk or the network, and a missing key falls back to English.
 *
 * The cast must stay inline: Vite only rewrites a literal `import.meta.glob(...)`.
 */
type EagerGlob = { glob: (pattern: string, opts: { eager: true; import: "default" }) => Record<string, object> };

const catalogs = (import.meta as unknown as EagerGlob).glob(
  "../../../../packages/app/src/i18n/locales/*/desktop.json",
  { eager: true, import: "default" },
);

const resources: Record<string, { desktop: object }> = {};
for (const [path, json] of Object.entries(catalogs)) {
  const code = /locales\/([^/]+)\/desktop\.json$/.exec(path)?.[1];
  if (code) resources[code] = { desktop: json };
}

const instance = createInstance();
void instance.init({
  ...buildInitOptions({ desktop: resources[DEFAULT_LOCALE]?.desktop ?? {} }),
  resources,
  defaultNS: "desktop",
  ns: ["desktop"],
  initAsync: false, // synchronous: menu/tray are built at startup, before any await
});

let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<(locale: Locale) => void>();

/** Translate a `desktop` namespace key in the current language. */
export function mainT(key: string, options?: TOptions): string {
  return instance.t(key, options) as string;
}

export function getMainLocale(): Locale {
  return current;
}

/** Initial language at startup: the mirrored choice, else the OS language. */
export function initMainLocale(stored: string | null, systemLocale: string): Locale {
  const locale = resolveLocale(stored, [systemLocale]);
  current = locale;
  void instance.changeLanguage(locale);
  return locale;
}

/** Apply a new language; returns false (and changes nothing) for an unknown code. */
export function setMainLocale(next: string): boolean {
  const locale = matchLocale(next);
  if (!locale) return false;
  if (locale === current) return true;
  current = locale;
  void instance.changeLanguage(locale);
  for (const cb of listeners) cb(locale);
  return true;
}

/** Subscribe to language changes (to rebuild the menu/tray). */
export function onMainLocaleChange(cb: (locale: Locale) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
