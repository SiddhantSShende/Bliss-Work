/**
 * The selector end to end: the real LanguageProvider feeding the real
 * LanguageSwitcher, with only the catalog loader mocked. Covers what the
 * provider tests don't — the menu lists all nine languages by their NATIVE
 * names, English is the default, picking an entry changes the active locale and
 * is remembered, and a failed load keeps the current language.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({ load: vi.fn(), toastError: vi.fn() }));
vi.mock("./catalogs", async (orig) => ({ ...(await orig<typeof import("./catalogs")>()), ensureLocaleLoaded: h.load }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: h.toastError, success: vi.fn() } }));

import { LanguageProvider } from "./LanguageProvider";
import { LanguageSwitcher } from "./LanguageSwitcher";
import i18n from "./index";

function mount() {
  return render(
    <LanguageProvider>
      <LanguageSwitcher />
    </LanguageProvider>,
  );
}

async function openMenu() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /language/i }));
  return user;
}

beforeEach(async () => {
  localStorage.clear();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US"]);
  h.load.mockReset().mockResolvedValue(undefined);
  h.toastError.mockReset();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

describe("LanguageSwitcher", () => {
  it("lists all nine languages by their native names", async () => {
    mount();
    await openMenu();
    const items = screen.getAllByRole("menuitemradio").map((el) => el.textContent);
    expect(items).toEqual([
      "English",
      "Español",
      "Français",
      "Deutsch",
      "हिन्दी",
      "Português",
      "日本語",
      "简体中文",
      "한국어",
    ]);
  });

  it("marks English as the current language by default", async () => {
    mount();
    await openMenu();
    expect(screen.getByRole("menuitemradio", { name: "English" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Español" })).toHaveAttribute("aria-checked", "false");
  });

  it("switches the active language, remembers it, and closes the menu", async () => {
    mount();
    const user = await openMenu();
    await user.click(screen.getByRole("menuitemradio", { name: "Deutsch" }));
    await waitFor(() => expect(i18n.language).toBe("de"));
    expect(localStorage.getItem("tb-locale")).toBe("de");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps the current language and reports an error when the catalog fails to load", async () => {
    mount();
    const user = await openMenu();
    h.load.mockRejectedValueOnce(new Error("offline"));
    await user.click(screen.getByRole("menuitemradio", { name: "日本語" }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(i18n.language).toBe("en");
    expect(localStorage.getItem("tb-locale")).toBeNull();
  });

  it("restores the persisted choice on the next load", async () => {
    localStorage.setItem("tb-locale", "ko");
    mount();
    await waitFor(() => expect(i18n.language).toBe("ko"));
    await openMenu();
    expect(screen.getByRole("menuitemradio", { name: "한국어" })).toHaveAttribute("aria-checked", "true");
  });
});
