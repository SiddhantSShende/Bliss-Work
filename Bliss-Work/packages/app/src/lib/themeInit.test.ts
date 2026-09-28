/**
 * theme-init.js runs before any bundler does, so it cannot import
 * packages/ui's theme code and carries a hand-copied version of it instead
 * (once in apps/web, once in apps/desktop). Copies drift silently — the symptom
 * is a flash of the wrong colours on every load — so this pins them to the real
 * thing: it executes each script against a stored custom theme and requires the
 * exact inline variables `customThemeStyle` produces.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { customThemeStyle } from "@taskboard/ui";

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
  it.each([
    ["one light colour (yellow → dark text)", ["#ffee00"]],
    ["one dark colour (navy → white text)", ["#001f5c"]],
    ["the editor's default indigo", ["#6366f1"]],
    ["two colours", ["#ff8800", "#aa2200"]],
    ["three colours", ["#0ea5e9", "#22c55e", "#f43f5e"]],
    ["mid grey, either side of the crossover", ["#808080"]],
  ])("applies exactly what customThemeStyle does for %s", (_label, colors) => {
    localStorage.setItem("tb-custom-theme", JSON.stringify({ colors }));
    localStorage.setItem("tb-custom-theme-active", "true");
    runScript(source);
    expect(root().classList.contains("custom-theme")).toBe(true);
    for (const [property, value] of Object.entries(customThemeStyle({ colors }))) {
      expect(root().style.getPropertyValue(property), property).toBe(value);
    }
  });

  it("still accepts a custom theme saved with the old `name` field", () => {
    localStorage.setItem("tb-custom-theme", JSON.stringify({ name: "Sunset", colors: ["#ff8800"] }));
    localStorage.setItem("tb-custom-theme-active", "true");
    runScript(source);
    expect(root().classList.contains("custom-theme")).toBe(true);
    expect(root().style.getPropertyValue("--color-accent")).toBe("#ff8800");
  });

  it.each([
    ["not active", { colors: ["#ff8800"] }, "false"],
    ["no colours", { colors: [] }, "true"],
    ["four colours", { colors: ["#111111", "#222222", "#333333", "#444444"] }, "true"],
    ["a non-hex colour", { colors: ["orange"] }, "true"],
  ])("applies nothing when the custom theme is %s", (_label, stored, active) => {
    localStorage.setItem("tb-custom-theme", JSON.stringify(stored));
    localStorage.setItem("tb-custom-theme-active", active);
    runScript(source);
    expect(root().classList.contains("custom-theme")).toBe(false);
    expect(root().style.getPropertyValue("--color-accent")).toBe("");
  });
});
