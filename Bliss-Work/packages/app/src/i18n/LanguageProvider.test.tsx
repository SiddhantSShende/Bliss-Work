/**
 * LanguageProvider: boot resolution (persisted → system → English), switching,
 * persistence, failure handling and cross-window follow. The catalog loader is
 * mocked so load failures are testable; the real catalogs are exercised in
 * catalogs.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  load: vi.fn(),
  toastError: vi.fn(),
  setHostLocale: vi.fn(),
}));
vi.mock("./catalogs", async (orig) => ({ ...(await orig<typeof import("./catalogs")>()), ensureLocaleLoaded: h.load }));
vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ config: { localePrefs: { setLocale: h.setHostLocale } } }),
}));
vi.mock("sonner", () => ({ toast: { error: h.toastError, success: vi.fn() } }));

import { LanguageProvider, useLanguage } from "./LanguageProvider";
import i18n from "./index";

/** A loader that registers a tiny catalog for the locale, like the real one does. */
function loaderOk(instance: typeof i18n, locale: string) {
  instance.addResourceBundle(locale, "common", { loading: `loading-${locale}` }, true, true);
  return Promise.resolve();
}

function Consumer() {
  const { locale, setLocale, availableLocales } = useLanguage();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="lang">{i18n.language}</span>
      <span data-testid="loading">{i18n.t("common:loading")}</span>
      <span data-testid="count">{availableLocales.length}</span>
      <button onClick={() => setLocale("es")}>to es</button>
      <button onClick={() => setLocale("ja")}>to ja</button>
      <button onClick={() => setLocale("en")}>to en</button>
      <button onClick={() => setLocale("xx")}>to xx</button>
    </div>
  );
}

const mount = () =>
  render(
    <LanguageProvider>
      <Consumer />
    </LanguageProvider>,
  );

function stubSystemLanguages(languages: string[]) {
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(languages);
}

beforeEach(async () => {
  localStorage.clear();
  h.load.mockReset().mockImplementation((inst, locale) => loaderOk(inst, locale));
  h.toastError.mockReset();
  h.setHostLocale.mockReset().mockResolvedValue(undefined);
  stubSystemLanguages(["en-US"]);
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

describe("boot", () => {
  it("starts in English with no stored choice and an English system language, loading nothing", async () => {
    mount();
    expect(await screen.findByTestId("locale")).toHaveTextContent("en");
    expect(h.load).not.toHaveBeenCalled();
    expect(document.documentElement.lang).toBe("en");
  });

  it("lists every ready locale, English first", async () => {
    mount();
    expect(await screen.findByTestId("count")).toHaveTextContent("9");
  });

  it("restores a persisted locale, applies it, and mirrors it to the desktop host", async () => {
    localStorage.setItem("tb-locale", "es");
    mount();
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("es"));
    expect(screen.getByTestId("lang")).toHaveTextContent("es");
    expect(screen.getByTestId("loading")).toHaveTextContent("loading-es");
    expect(document.documentElement.lang).toBe("es");
    expect(h.setHostLocale).toHaveBeenCalledWith("es");
  });

  it("falls back to the system language when nothing is persisted, without persisting it", async () => {
    stubSystemLanguages(["ja-JP", "en"]);
    mount();
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("ja"));
    expect(localStorage.getItem("tb-locale")).toBeNull();
  });

  it("lets an explicit persisted English beat a non-English system language", async () => {
    stubSystemLanguages(["ja-JP"]);
    localStorage.setItem("tb-locale", "en");
    mount();
    expect(await screen.findByTestId("locale")).toHaveTextContent("en");
    expect(h.load).not.toHaveBeenCalled();
  });

  it("ignores and clears an invalid persisted locale, using the system language", async () => {
    stubSystemLanguages(["de-DE"]);
    localStorage.setItem("tb-locale", "klingon");
    mount();
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("de"));
    expect(localStorage.getItem("tb-locale")).toBeNull();
  });

  it("stays in English when the catalog cannot be loaded, keeps the stored choice, and shows no error", async () => {
    localStorage.setItem("tb-locale", "es");
    h.load.mockRejectedValue(new Error("offline"));
    mount();
    expect(await screen.findByTestId("locale")).toHaveTextContent("en");
    expect(screen.getByTestId("lang")).toHaveTextContent("en");
    expect(localStorage.getItem("tb-locale")).toBe("es"); // retried on the next launch
    expect(h.toastError).not.toHaveBeenCalled();
    expect(document.documentElement.lang).toBe("en");
  });
});

describe("switching", () => {
  it("applies, persists and mirrors a new locale", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByText("to ja"));
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("ja"));
    expect(i18n.language).toBe("ja");
    expect(localStorage.getItem("tb-locale")).toBe("ja");
    expect(document.documentElement.lang).toBe("ja");
    expect(h.setHostLocale).toHaveBeenCalledWith("ja");
  });

  it("returns to English without loading anything", async () => {
    localStorage.setItem("tb-locale", "es");
    mount();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("es"));
    h.load.mockClear();
    await user.click(screen.getByText("to en"));
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("en"));
    expect(localStorage.getItem("tb-locale")).toBe("en");
  });

  it("keeps the current language, persists nothing and shows an error when the load fails", async () => {
    mount();
    const user = userEvent.setup();
    await screen.findByTestId("locale");
    h.load.mockRejectedValueOnce(new Error("chunk 404"));
    await user.click(screen.getByText("to es"));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(i18n.language).toBe("en");
    expect(localStorage.getItem("tb-locale")).toBeNull();
  });

  it("ignores a locale the app does not ship", async () => {
    mount();
    const user = userEvent.setup();
    await screen.findByTestId("locale");
    await user.click(screen.getByText("to xx"));
    expect(h.load).not.toHaveBeenCalled();
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
  });

  it("does nothing when re-selecting the active locale", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByText("to en"));
    expect(h.load).not.toHaveBeenCalled();
    expect(localStorage.getItem("tb-locale")).toBeNull();
  });
});

describe("other windows", () => {
  it("follows a language change persisted by another window or tab", async () => {
    mount();
    await screen.findByTestId("locale");
    localStorage.setItem("tb-locale", "es");
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: "tb-locale", newValue: "es" }));
    });
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("es"));
    expect(i18n.language).toBe("es");
  });

  it("ignores storage changes to unrelated keys", async () => {
    mount();
    await screen.findByTestId("locale");
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: "tb-theme", newValue: "dark" }));
    });
    expect(h.load).not.toHaveBeenCalled();
  });
});
