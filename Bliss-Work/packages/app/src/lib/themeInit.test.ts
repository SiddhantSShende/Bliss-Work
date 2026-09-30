/**
 * theme-init.js runs before auth restoration, so it must apply only the fixed
 * default and must not read saved preferences. These checks keep the web and
 * desktop copies aligned and verify that pre-auth routes ignore stored themes.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const SCRIPTS = {
  web: read("../../../../apps/web/public/theme-init.js"),
  desktop: read("../../../../apps/desktop/src/renderer/public/theme-init.js"),
};

const root = () => document.documentElement;
const runScript = (source: string) => new Function(source)();

beforeEach(() => {
  localStorage.clear();
  root().className = "";
  root().removeAttribute("style");
});

it("ships the same script to web and desktop", () => {
  expect(SCRIPTS.desktop).toBe(SCRIPTS.web);
});

describe.each(Object.entries(SCRIPTS))("%s theme-init.js", (_app, source) => {
  it.each(["/", "/login", "/mfa", "/2fa", "/backup-code", "/forgot-password", "/reset-password"])(
    "uses the default theme before authentication on %s",
    (path) => {
      window.history.replaceState({}, "", path);
      localStorage.setItem("tb-theme", "rose-dark");
      localStorage.setItem("tb-custom-theme", JSON.stringify({ colors: ["#ff8800"] }));
      localStorage.setItem("tb-custom-theme-active", "true");
      runScript(source);
      expect(root().classList.contains("light")).toBe(true);
      expect(root().classList.contains("bluePurple")).toBe(true);
      expect(root().classList.contains("rose")).toBe(false);
      expect(root().classList.contains("dark")).toBe(false);
      expect(root().classList.contains("custom-theme")).toBe(false);
      expect(root().style.cssText).toBe("");
    },
  );
});
