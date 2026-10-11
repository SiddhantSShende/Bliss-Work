// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme } from "./applyTheme";
import { CUSTOM_THEME_PROPERTIES } from "./customThemeTokens";

describe("applyTheme", () => {
  const root = document.documentElement;
  afterEach(() => {
    root.className = "";
    root.removeAttribute("style");
  });

  const accent = () => root.style.getPropertyValue("--color-accent");

  it("preset → custom → preset leaves nothing behind in either direction", () => {
    applyTheme(root, "rose", null);
    expect([...root.classList].sort()).toEqual(["light", "rose"]);
    expect(accent()).toBe("");

    applyTheme(root, "rose", { colors: ["#10b981"] });
    expect([...root.classList]).toEqual(["light"]); // no family class to leak from
    expect(accent()).toBe("#10b981");

    applyTheme(root, "purple", null);
    expect([...root.classList].sort()).toEqual(["light", "purple"]);
    for (const name of CUSTOM_THEME_PROPERTIES) expect(root.style.getPropertyValue(name), name).toBe("");
  });

  it("light ↔ dark re-derives every token for the new mode", () => {
    const custom = { colors: ["#10b981"] };
    applyTheme(root, "bluePurple", custom);
    expect(root.style.getPropertyValue("--color-bg")).toBe(""); // light shares the :root neutral
    applyTheme(root, "bluePurple-dark", custom);
    expect([...root.classList]).toEqual(["dark"]);
    expect(root.style.getPropertyValue("--color-bg")).toBe("#09090b");
    applyTheme(root, "bluePurple", custom);
    expect([...root.classList]).toEqual(["light"]);
    expect(root.style.getPropertyValue("--color-bg")).toBe("");
    expect(root.style.getPropertyValue("--color-border")).toBe("");
  });

  it("changing the custom colours replaces the old ones", () => {
    applyTheme(root, "blue", { colors: ["#10b981", "#06b6d4", "#a855f7"] });
    applyTheme(root, "blue", { colors: ["#ff8800"] });
    expect(root.style.getPropertyValue("--color-brand-from")).toBe("#ff8800");
    expect(root.style.getPropertyValue("--color-brand-to")).toBe("#ff8800");
    expect(root.style.getPropertyValue("--color-brand-mid")).toContain("#ff8800");
  });
});
