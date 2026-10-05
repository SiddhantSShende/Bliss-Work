/**
 * The meeting surface is pinned to the window by its own `fixed inset-0`, so
 * theme.css must not give `.meeting-surface` / `.meeting-mesh` a `position`.
 *
 * Those rules are unlayered, and unlayered CSS beats every Tailwind utility
 * (they live in `@layer utilities`) whatever the specificity. `.meeting-mesh`
 * used to say `position: relative`, which silently defeated the `fixed` on every
 * call surface: the room became an in-flow box as tall as its content rather
 * than a box the size of the window, so nothing inside it was bounded by the
 * window and the video area stopped following it. The ::before/::after orbs are
 * absolute on purpose and are not what this checks.
 *
 * The room must also not be scrollable, which is why `.meeting-mesh` says
 * `overflow: clip` (see its own comment in theme.css).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("../theme.css", import.meta.url), "utf8");

/** The declarations of the block opened by exactly `selector`. */
function declarations(selector: string): string {
  const escaped = selector.replace(/\./g, "\\$&");
  return CSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("meeting surface classes", () => {
  it(".meeting-mesh cannot be scrolled", () => {
    // overflow:hidden still leaves a box scrollable by script and by focus, and
    // the decorative orbs hang off this one, so there IS something to scroll to.
    // Shifting the room up uncovers them and pushes the bottom controls out of
    // the window; `clip` forbids scrolling outright.
    expect(declarations(".meeting-mesh")).toMatch(/overflow\s*:\s*clip/);
  });

  for (const selector of [".meeting-surface", ".meeting-mesh"]) {
    it(`${selector} sets no position of its own`, () => {
      const body = declarations(selector);
      // Found at all — otherwise a renamed rule would pass this vacuously.
      expect(body).not.toBe("");
      expect(body).not.toMatch(/(^|[;\s])position\s*:/);
    });
  }
});
