import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./catalogs", async (orig) => ({ ...(await orig<typeof import("./catalogs")>()), ensureLocaleLoaded: h.load }));

import i18n from "./index";
import { followStoredLocale } from "./windowLocale";

beforeEach(async () => {
  localStorage.clear();
  h.load.mockReset().mockResolvedValue(undefined);
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US"]);
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

describe("followStoredLocale (Electron secondary windows)", () => {
  it("applies the language the main window persisted", async () => {
    localStorage.setItem("tb-locale", "fr");
    await followStoredLocale();
    expect(h.load).toHaveBeenCalledWith(i18n, "fr");
    expect(i18n.language).toBe("fr");
    expect(document.documentElement.lang).toBe("fr");
  });

  it("stays English with nothing persisted", async () => {
    await followStoredLocale();
    expect(h.load).not.toHaveBeenCalled();
    expect(i18n.language).toBe("en");
  });

  it("keeps the current language when the catalog cannot be loaded", async () => {
    localStorage.setItem("tb-locale", "de");
    h.load.mockRejectedValue(new Error("offline"));
    await expect(followStoredLocale()).resolves.toBeUndefined();
    expect(i18n.language).toBe("en");
  });

  it("follows later changes made in the main window", async () => {
    await followStoredLocale();
    localStorage.setItem("tb-locale", "ko");
    window.dispatchEvent(new StorageEvent("storage", { key: "tb-locale", newValue: "ko" }));
    await vi.waitFor(() => expect(i18n.language).toBe("ko"));
  });
});
