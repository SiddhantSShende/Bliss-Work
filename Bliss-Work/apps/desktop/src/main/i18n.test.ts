import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMainLocale, initMainLocale, mainT, onMainLocaleChange, setMainLocale } from "./i18n";

// Main-process strings for the application menu, tray, OS notifications and
// dialogs. The module is Electron-free, so it runs in plain Node here against the
// real `desktop` catalogs shared with the renderer.

beforeEach(() => {
  initMainLocale(null, "en-US");
});

describe("initMainLocale", () => {
  it("defaults to English for an English system", () => {
    expect(getMainLocale()).toBe("en");
    expect(mainT("tray.show")).toBe("Show BlissWork");
  });

  it("uses the OS language when nothing was mirrored yet", () => {
    initMainLocale(null, "es-MX");
    expect(getMainLocale()).toBe("es");
    expect(mainT("tray.show")).not.toBe("Show BlissWork");
    expect(mainT("tray.show")).toContain("BlissWork");
  });

  it("prefers the mirrored choice over the OS language", () => {
    initMainLocale("fr", "es-ES");
    expect(getMainLocale()).toBe("fr");
  });

  it("ignores an invalid mirrored value and falls back to the OS language, then English", () => {
    initMainLocale("klingon", "fr-FR");
    expect(getMainLocale()).toBe("fr");
    initMainLocale("klingon", "ru-RU");
    expect(getMainLocale()).toBe("en");
  });
});

describe("setMainLocale", () => {
  it("switches the language and notifies subscribers once per real change", () => {
    const seen = vi.fn();
    const off = onMainLocaleChange(seen);
    expect(setMainLocale("de")).toBe(true);
    expect(seen).toHaveBeenCalledWith("de");
    expect(setMainLocale("de")).toBe(true); // same language: no new event
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    setMainLocale("ja");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("rejects a language the app does not ship and changes nothing", () => {
    expect(setMainLocale("xx")).toBe(false);
    expect(setMainLocale("")).toBe(false);
    expect(getMainLocale()).toBe("en");
  });
});

describe("mainT", () => {
  it("interpolates", () => {
    expect(mainT("updater.readyMessage", { version: "1.2.3" })).toBe("BlissWork 1.2.3 is ready to install.");
    setMainLocale("es");
    expect(mainT("updater.readyMessage", { version: "1.2.3" })).toContain("1.2.3");
  });

  it("pluralises per language (English one/other; Japanese other only)", () => {
    expect(mainT("tray.tooltipTasks", { count: 1 })).toBe("BlissWork — 1 active task");
    expect(mainT("tray.tooltipTasks", { count: 3 })).toBe("BlissWork — 3 active tasks");
    setMainLocale("ja");
    expect(mainT("tray.tooltipTasks", { count: 1 })).toContain("1");
    expect(mainT("tray.tooltipTasks", { count: 3 })).toContain("3");
  });

  it("never leaves an unresolved placeholder for any locale", () => {
    for (const code of ["en", "es", "fr", "de", "hi", "pt", "ja", "zh", "ko"]) {
      if (!setMainLocale(code)) continue;
      const out = [
        mainT("menu.aboutDetail", { version: "1", electron: "2", chrome: "3" }),
        mainT("attachment.downloadFailed", { status: 500 }),
        mainT("tray.activeTasks", { count: 2 }),
        mainT("tray.tooltipTasks", { count: 2 }),
      ];
      for (const s of out) expect(s, `${code}: ${s}`).not.toMatch(/\{\{|\}\}/);
    }
  });

  it("returns the key itself for a key that exists nowhere", () => {
    expect(mainT("no.such.key")).toBe("no.such.key");
  });
});
