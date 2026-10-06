/**
 * The selector end to end: the real LanguageProvider feeding the real
 * LanguageSwitcher, with only the API client faked. Covers what the provider
 * tests don't — that the dropdown lists every language auth-svc offers (not
 * just English), that English is the default, that picking an entry changes
 * the active locale, and that the pick survives a reload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  api: { i18nLanguages: vi.fn(), i18nCatalog: vi.fn() },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { LanguageProvider } from "./LanguageProvider";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useSession } from "../store/session";
import i18n from "./index";

const LANGUAGES = [
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
];
const catalogFor = (locale: string) => ({ locale, namespaces: { common: { loading: `loading-${locale}` } }, partial: false });

function mount() {
  return render(
    <LanguageProvider>
      <LanguageSwitcher />
    </LanguageProvider>,
  );
}

async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /language/i }));
  return user;
}

beforeEach(() => {
  localStorage.clear();
  h.api.i18nLanguages.mockReset().mockResolvedValue({ languages: LANGUAGES });
  h.api.i18nCatalog.mockReset().mockImplementation((locale: string) => Promise.resolve(catalogFor(locale)));
  useSession.setState({ status: "authed", user: null, accessToken: null, expiresAt: null });
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("LanguageSwitcher", () => {
  it("lists English plus every language the backend offers", async () => {
    mount();
    await waitFor(() => expect(h.api.i18nLanguages).toHaveBeenCalledTimes(1));
    await openMenu();

    await waitFor(() => expect(screen.getAllByRole("menuitemradio")).toHaveLength(4));
    expect(screen.getAllByRole("menuitemradio").map((el) => el.textContent)).toEqual(["English", "Spanish", "French", "German"]);
  });

  it("defaults to English with nothing persisted", async () => {
    mount();
    await openMenu();

    expect(screen.getByRole("menuitemradio", { name: "English" })).toHaveAttribute("aria-checked", "true");
    expect(i18n.language).toBe("en");
    expect(localStorage.getItem("tb-locale")).toBeNull();
  });

  it("changes the active locale and persists it when another language is picked", async () => {
    mount();
    await waitFor(() => expect(h.api.i18nLanguages).toHaveBeenCalled());
    const user = await openMenu();
    await waitFor(() => expect(screen.getAllByRole("menuitemradio")).toHaveLength(4));

    await user.click(screen.getByRole("menuitemradio", { name: "French" }));

    await waitFor(() => expect(i18n.language).toBe("fr"));
    expect(h.api.i18nCatalog).toHaveBeenCalledWith("fr");
    expect(localStorage.getItem("tb-locale")).toBe("fr");

    await user.click(screen.getByRole("button", { name: /language/i }));
    expect(screen.getByRole("menuitemradio", { name: "French" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "English" })).toHaveAttribute("aria-checked", "false");
  });

  it("restores the persisted locale after a reload", async () => {
    const first = mount();
    await waitFor(() => expect(h.api.i18nLanguages).toHaveBeenCalled());
    const user = await openMenu();
    await waitFor(() => expect(screen.getAllByRole("menuitemradio")).toHaveLength(4));
    await user.click(screen.getByRole("menuitemradio", { name: "German" }));
    await waitFor(() => expect(i18n.language).toBe("de"));

    // "Reload": drop the React tree and the in-memory language, keep storage.
    first.unmount();
    await i18n.changeLanguage("en");
    h.api.i18nCatalog.mockClear();
    mount();

    await waitFor(() => expect(i18n.language).toBe("de"));
    // Served from the client catalog cache the first visit wrote — no refetch.
    expect(h.api.i18nCatalog).not.toHaveBeenCalled();
    await openMenu();
    expect(await screen.findByRole("menuitemradio", { name: "German" })).toHaveAttribute("aria-checked", "true");
  });
});
