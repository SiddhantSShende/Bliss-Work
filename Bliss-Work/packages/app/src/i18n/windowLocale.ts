import i18n from "./index";

// Re-exported so the desktop renderer entries need not depend on react-i18next
// directly (that package is the app's dependency, not theirs).
export { useTranslation } from "react-i18next";
import { ensureLocaleLoaded } from "./catalogs";
import { applyDocumentLanguage, LOCALE_STORAGE_KEY, readStoredLocale, resolveLocale, systemLanguages } from "./core";
import { DEFAULT_LOCALE } from "./locales";

/**
 * Language for the Electron secondary windows (sticky notes, pinned chat,
 * meeting invite). They mount no LanguageProvider, but they share localStorage
 * with the main window (the same fact their theme sync relies on — see
 * apps/desktop/src/renderer/sticky.tsx), so they read the main window's
 * persisted `tb-locale` and follow its `storage` events.
 *
 * Resolves once the first language is applied (English on any failure), so the
 * caller can render after it. Returns nothing to clean up: these windows live
 * for the lifetime of their renderer.
 */
export async function followStoredLocale(): Promise<void> {
  const apply = async (locale: string) => {
    try {
      await ensureLocaleLoaded(i18n, locale);
      await i18n.changeLanguage(locale);
      applyDocumentLanguage(locale);
    } catch {
      // Offline/chunk failure: keep whatever language is already showing.
    }
  };

  window.addEventListener("storage", (e) => {
    if (e.key !== LOCALE_STORAGE_KEY && e.key !== null) return;
    void apply(resolveLocale(readStoredLocale(), systemLanguages()));
  });

  const initial = resolveLocale(readStoredLocale(), systemLanguages());
  if (initial === DEFAULT_LOCALE) {
    applyDocumentLanguage(DEFAULT_LOCALE);
    return;
  }
  await apply(initial);
}
