import { createContext, useContext, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import i18n, { DEFAULT_LOCALE } from "./index";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";

export interface LocaleOption {
  code: string;
  englishName: string;
  nativeName: string;
}

// English is the only locale bundled at build time — never fetched, and
// available even with no Google credential configured or no session yet.
// Every other option the switcher lists is fetched live from auth-svc (see
// the languages effect below) — this app never hardcodes a language list.
const BUNDLED_OPTIONS: LocaleOption[] = [{ code: DEFAULT_LOCALE, englishName: "English", nativeName: "English" }];

const LanguageCtx = createContext<{
  locale: string;
  setLocale: (locale: string) => void;
  availableLocales: LocaleOption[];
}>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  availableLocales: BUNDLED_OPTIONS,
});

const LOCALE_KEY = "tb-locale";
const CATALOG_CACHE_PREFIX = "tb-i18n-catalog:";
// Matches auth-svc's own Google-language-list TTL — one deliberate constant
// for "how long a fetched i18n artifact is trusted without asking again",
// reused on both sides rather than inventing a second number.
const CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Read the persisted locale. No stored value, or storage unavailable (private
 * mode, disabled cookies) — resolves to English.
 *
 * Unlike the old static build, the valid set isn't known synchronously any
 * more — it's whatever auth-svc's live Google Cloud Translation check
 * returns, which needs a network round trip this function can't make. So
 * this only sanity-checks the SHAPE of a stored value (a plausible BCP-47-ish
 * code), not membership in a known set; an invalid or now-unsupported code
 * just fails its fetch later and falls back to English then (see the
 * reconciliation effect in LanguageProvider).
 * Mirrors ThemeProvider's readStoredTheme (packages/ui/src/theme/ThemeProvider.tsx).
 */
function readStoredLocale(): string {
  try {
    const v = localStorage.getItem(LOCALE_KEY);
    return v && /^[a-zA-Z]{2,3}(-[a-zA-Z]{2,8})?$/.test(v) ? v : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function persistLocale(locale: string) {
  try {
    localStorage.setItem(LOCALE_KEY, locale);
  } catch {
    // The manual choice still applies for this session.
  }
}

interface CachedCatalog {
  namespaces: Record<string, object>;
  cachedAt: number;
}

/** A previously-fetched catalog, if one exists and is still fresh — the
 *  client-side half of "returning to a previously used language is fast":
 *  no network call at all on a cache hit. */
function readCachedCatalog(locale: string): Record<string, object> | null {
  try {
    const raw = localStorage.getItem(CATALOG_CACHE_PREFIX + locale);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedCatalog;
    if (typeof parsed.cachedAt !== "number" || Date.now() - parsed.cachedAt > CATALOG_CACHE_TTL_MS) return null;
    return parsed.namespaces;
  } catch {
    return null;
  }
}

function writeCachedCatalog(locale: string, namespaces: Record<string, object>) {
  try {
    const entry: CachedCatalog = { namespaces, cachedAt: Date.now() };
    localStorage.setItem(CATALOG_CACHE_PREFIX + locale, JSON.stringify(entry));
  } catch {
    // Not fatal — the locale still applies for this session, just refetches
    // (from auth-svc's own Redis cache, so still cheap) next time.
  }
}

/** Feeds a fetched or cached catalog into the running i18next instance.
 *  `deep`+`overwrite` so a refetched namespace replaces stale keys rather
 *  than only ever adding new ones. */
function applyCatalog(locale: string, namespaces: Record<string, object>) {
  for (const [namespace, resources] of Object.entries(namespaces)) {
    i18n.addResourceBundle(locale, namespace, resources, true, true);
  }
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation("common");
  const { api } = useRuntime();
  const authed = useSession((s) => s.status === "authed");
  const [locale, setLocaleState] = useState<string>(readStoredLocale);
  const [extraLocales, setExtraLocales] = useState<LocaleOption[]>([]);
  const fetchedLanguages = useRef(false);

  // The live language list — fetched once per session, after the user is
  // authenticated (GET /i18n/languages requires it, and the switcher that
  // reads this never renders before then; see TopNavbar). Failure here is
  // silent: the dropdown simply stays English-only, indistinguishable from
  // no Google credential being configured at all — not a user-facing error,
  // since nothing the user did caused it.
  useEffect(() => {
    if (!authed || fetchedLanguages.current) return;
    fetchedLanguages.current = true;
    void api
      .i18nLanguages()
      .then((res) => {
        setExtraLocales(res.languages.map((l) => ({ code: l.code, englishName: l.name, nativeName: l.name })));
      })
      .catch(() => {});
  }, [authed, api]);

  // Reconciles whatever `locale` currently is — the persisted choice on
  // first mount, or a fresh pick from setLocale below — with i18next's
  // loaded resources. English needs nothing further; it is always bundled.
  // A cache hit applies immediately, authenticated or not (reading
  // localStorage needs no session). A cache MISS needs GET /i18n/catalog,
  // which is authenticated, so a non-English choice made before login simply
  // waits for one — the effect re-runs once `authed` flips true — rather
  // than failing outright. Any genuine fetch failure here is a boot-time
  // reconciliation, not a response to a click, so it fails silently to
  // English for this session rather than surfacing an unsolicited toast, and
  // leaves the persisted choice untouched in case the failure was transient.
  useEffect(() => {
    if (locale === DEFAULT_LOCALE) {
      void i18n.changeLanguage(DEFAULT_LOCALE);
      return;
    }
    const cached = readCachedCatalog(locale);
    if (cached) {
      applyCatalog(locale, cached);
      void i18n.changeLanguage(locale);
      return;
    }
    if (!authed) return;
    void api
      .i18nCatalog(locale)
      .then((res) => {
        applyCatalog(locale, res.namespaces);
        writeCachedCatalog(locale, res.namespaces);
        void i18n.changeLanguage(locale);
      })
      .catch(() => {});
  }, [locale, authed, api]);

  /** The one entry point LanguageSwitcher calls. English switches
   *  immediately; anything else is served from the client cache if fresh, or
   *  fetched-then-applied otherwise. The active locale (and `tb-locale`) is
   *  left untouched on failure — see the requirement this satisfies in
   *  i18n/LanguageProvider's own change log: "keep the current language and
   *  show an appropriate error." */
  const setLocale = (next: string) => {
    if (next === locale) return;
    if (next === DEFAULT_LOCALE) {
      persistLocale(next);
      setLocaleState(next);
      return;
    }
    const cached = readCachedCatalog(next);
    if (cached) {
      applyCatalog(next, cached);
      void i18n.changeLanguage(next);
      persistLocale(next);
      setLocaleState(next);
      return;
    }
    void api
      .i18nCatalog(next)
      .then((res) => {
        applyCatalog(next, res.namespaces);
        writeCachedCatalog(next, res.namespaces);
        void i18n.changeLanguage(next);
        persistLocale(next);
        setLocaleState(next);
      })
      .catch(() => {
        toast.error(t("language.switchFailed"));
      });
  };

  return (
    <LanguageCtx.Provider
      value={{ locale, setLocale, availableLocales: BUNDLED_OPTIONS.concat(extraLocales) }}
    >
      {children}
    </LanguageCtx.Provider>
  );
}

export const useLanguage = () => useContext(LanguageCtx);
