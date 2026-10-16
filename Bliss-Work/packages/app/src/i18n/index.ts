import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { logger } from "@taskboard/shared";
import { buildInitOptions } from "./core";
import { englishResources } from "./catalogs";

export { DEFAULT_LOCALE, type Locale } from "./locales";

/** Every namespace = one JSON file under locales/en/. Adding a namespace is just
 *  adding the file (in every locale directory — scripts/check-locales.mjs
 *  enforces that). */
export const NAMESPACES = Object.keys(englishResources);

// `import.meta.env` is Vite's build-time env (statically replaced). packages/app
// is consumed by both the web + electron Vite builds; cast so this compiles
// without pulling vite/client types into this shared package's tsconfig — same
// pattern as lib/buildInfo.ts.
const isDev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;

// A side-effect import: App.tsx (via LanguageProvider) and test/setup.ts rely on
// this running at import time. Only English is registered here; the user's
// language is loaded and applied by LanguageProvider.
void i18n.use(initReactI18next).init(buildInitOptions(englishResources, { dev: isDev, warn: logger.warn }));

export default i18n;
