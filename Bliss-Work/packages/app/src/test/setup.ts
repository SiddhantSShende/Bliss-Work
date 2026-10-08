/**
 * Global test setup for packages/app.
 *
 * Everything here exists because jsdom lacks a browser API the app touches at
 * import or render time. Each stub is the smallest thing that makes the real
 * component run — none of them change behavior under test.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Normally a side effect of importing App.tsx (via LanguageProvider) at the
// real app's entry point. Tests render route/feature components directly,
// without ever mounting <App>, so without this i18next stays uninitialized
// and useTranslation()'s t() falls back to returning the raw key instead of
// the English string.
import i18n from "../i18n";

// A key that exists in no language renders as the raw key in the product, and
// nothing else would ever notice. i18next only reports a miss when the whole
// fallback chain (active language → English) comes up empty, so this is exactly
// "someone used a key that is not in locales/en".
const missingKeys: string[] = [];
i18n.options.saveMissing = true;
i18n.options.missingKeyHandler = (_langs, ns, key) => {
  missingKeys.push(`${ns}:${key}`);
};

// Unmount between tests. Without this the previous test's tree is still in the
// document and queries match the wrong element — which shows up as a confusing
// "found multiple elements" much later, in an unrelated test.
afterEach(() => {
  cleanup();
  if (missingKeys.length > 0) {
    const missing = [...new Set(missingKeys)].join(", ");
    missingKeys.length = 0;
    throw new Error(`Translation key(s) missing from locales/en: ${missing}`);
  }
});

// framer-motion (Modal, Sheet) and the responsive layout read this. jsdom has
// no matchMedia at all, so its absence is a TypeError at render.
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// Used by virtualized lists and anything measuring itself. jsdom ships no
// implementation, and the constructor throwing takes down the whole render.
//
// Assigned through a widened alias: `"X" in window` narrows `window` to `never`
// for the assignment that follows, since TS knows the global declares X.
const w = window as unknown as Record<string, unknown>;

if (!w.ResizeObserver) {
  w.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!w.IntersectionObserver) {
  w.IntersectionObserver = class {
    root = null;
    rootMargin = "";
    thresholds: number[] = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
}

// jsdom implements neither. `scrollIntoView` is called by the chat thread on
// every render; `scrollTo` by the modal body.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
}

// crypto.randomUUID is used for optimistic message ids. jsdom's crypto has
// getRandomValues but not randomUUID on some versions.
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: () => "00000000-0000-4000-8000-000000000000",
    configurable: true,
  });
}

// jsdom does not implement Blob object URLs at all (createObjectURL throws
// "not implemented"). Used by lib/download.ts and lib/useBlobUrl.ts (in-app
// document preview); tests that exercise either mock the URL further, but the
// render must not throw before they get the chance to.
if (!URL.createObjectURL) {
  URL.createObjectURL = vi.fn(() => "blob:mock");
}
if (!URL.revokeObjectURL) {
  URL.revokeObjectURL = vi.fn();
}
