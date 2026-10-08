import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import i18n from "./index";
import { ensureLocaleLoaded } from "./catalogs";
import { UiStringsBridge } from "./UiStringsBridge";
import { useRuntime } from "../lib/runtime";
import {
  LOCALE_STORAGE_KEY,
  applyDocumentLanguage,
  persistLocale,
  readStoredLocale,
  resolveLocale,
  systemLanguages,
} from "./core";
import { DEFAULT_LOCALE, SELECTABLE_LOCALES, matchLocale, type Locale, type LocaleInfo } from "./locales";

const LanguageCtx = createContext<{
  locale: Locale;
  setLocale: (locale: string) => void;
  availableLocales: readonly LocaleInfo[];
}>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  availableLocales: SELECTABLE_LOCALES,
});

/** How long first paint waits for the persisted language's catalog before it
 *  renders English and swaps once the catalog lands. */
const BOOT_WAIT_MS = 1500;

/**
 * Owns the active UI language.
 *
 * Boot: persisted choice → system language → English (core.resolveLocale). A
 * non-English catalog is a small lazy chunk; if it cannot be loaded (offline,
 * CDN error) the app stays in English and the stored choice is left alone so
 * the next launch retries. User-initiated switches that fail keep the current
 * language and show an error toast.
 *
 * Only an explicit pick is persisted — a language inferred from the system is
 * not, so it keeps following the system until the user chooses.
 */
export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation("common");
  const { config } = useRuntime();
  const hostLocale = config.localePrefs;
  const [initial] = useState<Locale>(() => resolveLocale(readStoredLocale(), systemLanguages()));
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [ready, setReady] = useState(initial === DEFAULT_LOCALE);

  useEffect(() => {
    const target = initial;
    if (target === DEFAULT_LOCALE) {
      applyDocumentLanguage(DEFAULT_LOCALE);
      void hostLocale?.setLocale(DEFAULT_LOCALE);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => setReady(true), BOOT_WAIT_MS);
    void ensureLocaleLoaded(i18n, target)
      .then(() => i18n.changeLanguage(target))
      .then(() => {
        if (cancelled) return;
        setLocaleState(target);
        applyDocumentLanguage(target);
        void hostLocale?.setLocale(target);
      })
      .catch(() => applyDocumentLanguage(DEFAULT_LOCALE)) // stay English; stored choice untouched
      .finally(() => {
        clearTimeout(timer);
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Boot-only: later changes go through setLocale below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  // Another tab / Electron window (main window ↔ meeting window) changed the
  // language: follow it. Other windows have already persisted it, so nothing is
  // written back here and no error toast — a failed load just keeps the language.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== LOCALE_STORAGE_KEY && e.key !== null) return;
      const target = resolveLocale(readStoredLocale(), systemLanguages());
      if (target === i18n.language) return;
      void ensureLocaleLoaded(i18n, target)
        .then(() => i18n.changeLanguage(target))
        .then(() => {
          setLocaleState(target);
          applyDocumentLanguage(target);
          void hostLocale?.setLocale(target);
        })
        .catch(() => {});
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [hostLocale]);

  const setLocale = useCallback(
    (next: string) => {
      const target = matchLocale(next);
      if (!target || target === locale) return;
      void ensureLocaleLoaded(i18n, target)
        .then(() => i18n.changeLanguage(target))
        .then(() => {
          persistLocale(target);
          setLocaleState(target);
          applyDocumentLanguage(target);
          void hostLocale?.setLocale(target);
        })
        .catch(() => {
          toast.error(t("language.switchFailed"));
        });
    },
    [locale, t, hostLocale],
  );

  const value = useMemo(
    () => ({ locale, setLocale, availableLocales: SELECTABLE_LOCALES }),
    [locale, setLocale],
  );

  return (
    <LanguageCtx.Provider value={value}>
      <UiStringsBridge>{ready ? children : null}</UiStringsBridge>
    </LanguageCtx.Provider>
  );
}

export const useLanguage = () => useContext(LanguageCtx);
