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

// The gateway's initial set (I18N_LOCALES default). Mirrors what translate-gw
// returns — the client holds no list of its own, so these come from the API.
const GATEWAY_LANGUAGES = [
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "hi", name: "Hindi" },
  { code: "pt", name: "Portuguese" },
  { code: "ja", name: "Japanese" },
  { code: "zh", name: "Chinese (Simplified)" },
  { code: "ko", name: "Korean" },
];

describe("LanguageProvider — language list from the translation gateway", () => {
  it("offers English plus every language the API returns, in the API's order", async () => {
    useSession.setState({ status: "authed" });
    h.api.i18nLanguages.mockResolvedValue({ languages: GATEWAY_LANGUAGES });
    let codes: string[] = [];
    function Codes() {
      codes = useLanguage().availableLocales.map((l) => l.code);
      return null;
    }
    render(
      <LanguageProvider>
        <Codes />
      </LanguageProvider>,
    );

    await waitFor(() => expect(codes).toHaveLength(9));
    expect(codes).toEqual(["en", "es", "fr", "de", "hi", "pt", "ja", "zh", "ko"]);
  });

  it("never lists English twice if the API includes it", async () => {
    useSession.setState({ status: "authed" });
    h.api.i18nLanguages.mockResolvedValue({ languages: [{ code: "en", name: "English" }, ...GATEWAY_LANGUAGES.slice(0, 2)] });
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("option-count")).toHaveTextContent("3"));
  });

  it("stays English-only when the language list request fails", async () => {
    useSession.setState({ status: "authed" });
    h.api.i18nLanguages.mockRejectedValue(new Error("503"));
    renderProvider();

    await waitFor(() => expect(h.api.i18nLanguages).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId("option-count")).toHaveTextContent("1");
    expect(h.toastError).not.toHaveBeenCalled();
  });
});

describe("LanguageProvider — English fallback", () => {
  function Probe({ ns, k }: { ns: string; k: string }) {
    const { t } = useTranslation(ns);
    return <p data-testid="probe">{t(k)}</p>;
  }
  const mountProbe = (ns: string, k: string) =>
    render(
      <LanguageProvider>
        <Consumer />
        <Probe ns={ns} k={k} />
      </LanguageProvider>,
    );

  it("renders the English string for a key the translated catalog lacks", async () => {
    useSession.setState({ status: "authed" });
    // common.language.changeLanguage exists in the bundled English, not in this catalog.
    h.api.i18nCatalog.mockResolvedValue(ES_CATALOG);
    mountProbe("common", "language.changeLanguage");
    const user = userEvent.setup();

    await user.click(screen.getByText("switch to es"));

    await waitFor(() => expect(i18n.language).toBe("es"));
    expect(i18n.getResourceBundle("es", "common")).toEqual({ loading: "Cargando…" });
    expect(screen.getByTestId("probe")).toHaveTextContent("Change language");
  });

  it("renders English for a namespace the translated catalog omits entirely", async () => {
    useSession.setState({ status: "authed" });
    h.api.i18nCatalog.mockResolvedValue(ES_CATALOG);
    mountProbe("tasks", "tasksPage.newTask");
    const before = screen.getByTestId("probe").textContent;
    const user = userEvent.setup();

    await user.click(screen.getByText("switch to es"));

    await waitFor(() => expect(i18n.language).toBe("es"));
    expect(before).toBe("New task"); // the key really exists in English
    expect(screen.getByTestId("probe").textContent).toBe(before);
  });

  it("does not keep a partial catalog in the client cache, so the next visit asks again", async () => {
    useSession.setState({ status: "authed" });
    h.api.i18nCatalog.mockResolvedValue({ ...ES_CATALOG, partial: true });
    renderProvider();
    const user = userEvent.setup();

    await user.click(screen.getByText("switch to es"));
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("es"));

    expect(localStorage.getItem("tb-i18n-catalog:es")).toBeNull();
    expect(localStorage.getItem("tb-locale")).toBe("es");
  });

  it("does cache a complete catalog", async () => {
    useSession.setState({ status: "authed" });
    h.api.i18nCatalog.mockResolvedValue(ES_CATALOG);
    renderProvider();
    const user = userEvent.setup();

    await user.click(screen.getByText("switch to es"));
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("es"));

    expect(JSON.parse(localStorage.getItem("tb-i18n-catalog:es") ?? "{}").namespaces).toEqual(ES_CATALOG.namespaces);
  });
});

describe("LanguageProvider — persisted locale restoration", () => {
  it("restores a persisted locale from the client cache with no network and no session", async () => {
    localStorage.setItem("tb-locale", "es");
    localStorage.setItem("tb-i18n-catalog:es", JSON.stringify({ namespaces: ES_CATALOG.namespaces, cachedAt: Date.now() }));
    renderProvider(); // status stays "anon"

    await waitFor(() => expect(i18n.language).toBe("es"));
    expect(screen.getByTestId("locale")).toHaveTextContent("es");
    expect(h.api.i18nCatalog).not.toHaveBeenCalled();
  });

  it("restores a persisted locale with no cached catalog by fetching it once the session exists", async () => {
    localStorage.setItem("tb-locale", "es");
    h.api.i18nCatalog.mockResolvedValue(ES_CATALOG);
    renderProvider();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.api.i18nCatalog).not.toHaveBeenCalled(); // authenticated endpoint: waits for login
    expect(i18n.language).toBe("en");

    useSession.setState({ status: "authed" });

    await waitFor(() => expect(i18n.language).toBe("es"));
    expect(h.api.i18nCatalog).toHaveBeenCalledWith("es");
    expect(screen.getByTestId("locale")).toHaveTextContent("es");
  });

  it("ignores an expired cached catalog and fetches a fresh one", async () => {
    localStorage.setItem("tb-locale", "es");
    localStorage.setItem(
      "tb-i18n-catalog:es",
      JSON.stringify({ namespaces: { common: { loading: "viejo" } }, cachedAt: Date.now() - 25 * 60 * 60 * 1000 }),
    );
    useSession.setState({ status: "authed" });
    h.api.i18nCatalog.mockResolvedValue(ES_CATALOG);
    renderProvider();

    await waitFor(() => expect(h.api.i18nCatalog).toHaveBeenCalledWith("es"));
    await waitFor(() => expect(i18n.getResourceBundle("es", "common")).toEqual({ loading: "Cargando…" }));
  });

  it("stays on English, silently, when restoring a persisted locale fails", async () => {
    localStorage.setItem("tb-locale", "es");
    useSession.setState({ status: "authed" });
    h.api.i18nCatalog.mockRejectedValue(new Error("503"));
    renderProvider();

    await waitFor(() => expect(h.api.i18nCatalog).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(i18n.language).toBe("en");
    expect(h.toastError).not.toHaveBeenCalled(); // a boot-time reconcile, not a click
    expect(localStorage.getItem("tb-locale")).toBe("es"); // choice kept for a transient failure
  });
});
