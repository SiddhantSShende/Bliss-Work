/**
 * The dynamic half of language switching: English is instant and needs no
 * network; anything else is fetched from auth-svc's /i18n/catalog, applied to
 * the running i18next instance, and cached client-side so picking the same
 * language again never re-fetches. A failed fetch must leave the active
 * locale exactly where it was — never a half-switched UI — and tell the user.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useTranslation } from "react-i18next";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  api: { i18nLanguages: vi.fn(), i18nCatalog: vi.fn() },
  toastError: vi.fn(),
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: h.toastError, success: vi.fn() } }));

import { LanguageProvider, useLanguage } from "./LanguageProvider";
import { useSession } from "../store/session";
import i18n from "./index";

const ES_CATALOG = {
  locale: "es",
  namespaces: { common: { loading: "Cargando…" } },
  partial: false,
};

function Consumer() {
  const { locale, setLocale, availableLocales } = useLanguage();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="i18n-lang">{i18n.language}</span>
      <span data-testid="option-count">{availableLocales.length}</span>
      <button onClick={() => setLocale("es")}>switch to es</button>
      <button onClick={() => setLocale("en")}>switch to en</button>
    </div>
  );
}

function renderProvider() {
  render(
    <LanguageProvider>
      <Consumer />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  h.api.i18nLanguages.mockReset();
  h.api.i18nCatalog.mockReset();
  h.toastError.mockReset();
  h.api.i18nLanguages.mockResolvedValue({ languages: [{ code: "es", name: "Spanish" }] });
  useSession.setState({ status: "anon", user: null, accessToken: null, expiresAt: null });
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("LanguageProvider — dynamic locale fetch", () => {
  it("switches to English immediately, with no backend call", async () => {
    useSession.setState({ status: "authed" });
    renderProvider();
    const user = userEvent.setup();

    await user.click(screen.getByText("switch to en"));

    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(h.api.i18nCatalog).not.toHaveBeenCalled();
  });

  it("fetches, applies, and switches to a new locale on selection", async () => {
    useSession.setState({ status: "authed" });
    h.api.i18nCatalog.mockResolvedValue(ES_CATALOG);
    renderProvider();
    const user = userEvent.setup();

    await user.click(screen.getByText("switch to es"));

    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("es"));
    expect(h.api.i18nCatalog).toHaveBeenCalledWith("es");
    expect(i18n.getResourceBundle("es", "common")).toEqual({ loading: "Cargando…" });
    expect(localStorage.getItem("tb-locale")).toBe("es");
  });

  it("does not re-fetch a locale that is already cached client-side", async () => {
    useSession.setState({ status: "authed" });
    h.api.i18nCatalog.mockResolvedValue(ES_CATALOG);
    renderProvider();
    const user = userEvent.setup();

    await user.click(screen.getByText("switch to es"));
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("es"));
    expect(h.api.i18nCatalog).toHaveBeenCalledTimes(1);

    await user.click(screen.getByText("switch to en"));
    expect(screen.getByTestId("locale")).toHaveTextContent("en");

    await user.click(screen.getByText("switch to es"));
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("es"));

    // Second selection of "es" is served from the localStorage cache written
    // by the first — the backend (and, transitively, Google) is never asked
    // again for a locale this browser already has.
    expect(h.api.i18nCatalog).toHaveBeenCalledTimes(1);
  });

  it("keeps the current locale and shows an error when the fetch fails", async () => {
    useSession.setState({ status: "authed" });
    h.api.i18nCatalog.mockRejectedValue(new Error("network down"));
    renderProvider();
    const user = userEvent.setup();

    await user.click(screen.getByText("switch to es"));

    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(i18n.language).toBe("en");
    expect(localStorage.getItem("tb-locale")).toBeNull();
  });

  it("switches to Hindi and the visible strings change, placeholders intact", async () => {
    useSession.setState({ status: "authed" });
    h.api.i18nCatalog.mockResolvedValue({
      locale: "hi",
      namespaces: { common: { loading: "लोड हो रहा है…", due: "{{count}} कार्य बाकी" } },
      partial: false,
    });
    function Probe() {
      const { t } = useTranslation("common");
      const { setLocale } = useLanguage();
      return <button onClick={() => setLocale("hi")}>{t("due", { count: 3, defaultValue: "{{count}} tasks due" })}</button>;
    }
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>,
    );
    const user = userEvent.setup();
    expect(screen.getByRole("button")).toHaveTextContent("3 tasks due");

    await user.click(screen.getByRole("button"));

    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent("3 कार्य बाकी"));
    expect(h.api.i18nCatalog).toHaveBeenCalledWith("hi");
  });

  it("treats a malformed persisted locale as English without calling the backend", async () => {
    localStorage.setItem("tb-locale", "not a locale!!");
    useSession.setState({ status: "authed" });
    renderProvider();
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(h.api.i18nCatalog).not.toHaveBeenCalled();
  });

  it("falls back to English and tells the user when the backend rejects an unsupported locale", async () => {
    useSession.setState({ status: "authed" });
    h.api.i18nCatalog.mockRejectedValue(new Error("400 unsupported locale: es"));
    renderProvider();
    const user = userEvent.setup();

    await user.click(screen.getByText("switch to es"));

    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(localStorage.getItem("tb-locale")).toBeNull();
  });

  it("lists languages fetched from the backend alongside the bundled English option", async () => {
    useSession.setState({ status: "authed" });
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("option-count")).toHaveTextContent("2"));
    expect(h.api.i18nLanguages).toHaveBeenCalledTimes(1);
  });

  it("does not call the authenticated endpoints before a session exists", async () => {
    // status stays "anon" from beforeEach — mirrors the pre-login screens
    // LanguageProvider also wraps (see App.tsx).
    renderProvider();
    await new Promise((r) => setTimeout(r, 0));

    expect(h.api.i18nLanguages).not.toHaveBeenCalled();
    expect(h.api.i18nCatalog).not.toHaveBeenCalled();
    expect(screen.getByTestId("option-count")).toHaveTextContent("1");
  });
});
