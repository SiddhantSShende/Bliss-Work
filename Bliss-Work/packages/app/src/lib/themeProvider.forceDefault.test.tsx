/**
 * @taskboard/ui's ThemeProvider `forceDefault` prop — what keeps Login and
 * Signup FIXED to the default BlissWork theme regardless of what the
 * signed-in user (or a previous session on this device) has selected. See
 * ThemeProvider.tsx's own doc comment for the full design, and App.tsx's
 * ThemedTree for how `forceDefault` is actually derived from the current
 * route in this app.
 *
 * Lives here rather than in packages/ui because that package has no jsdom
 * test environment configured (its one existing test, themes.test.ts, is
 * pure-function-only) — packages/app already does, and already depends on
 * @taskboard/ui, so this is the natural place to exercise a REAL
 * ThemeProvider against a real DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ThemeProvider } from "@taskboard/ui";

function mockMatchMedia(prefersDark: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("dark") ? prefersDark : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

const htmlClasses = () => Array.from(document.documentElement.classList);

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  mockMatchMedia(false);
});

afterEach(() => {
  cleanup();
  document.documentElement.className = "";
  vi.restoreAllMocks();
});

describe("ThemeProvider forceDefault", () => {
  it("shows the stored theme when not forced", () => {
    localStorage.setItem("tb-theme", "purple");
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    expect(htmlClasses()).toContain("purple");
  });

  it("shows the default theme instead of the stored Purple selection when forced", () => {
    localStorage.setItem("tb-theme", "purple");
    render(
      <ThemeProvider forceDefault>
        <div />
      </ThemeProvider>,
    );
    expect(htmlClasses()).toContain("default");
    expect(htmlClasses()).not.toContain("purple");
  });

  it("shows the default theme instead of the stored Rose selection when forced", () => {
    localStorage.setItem("tb-theme", "rose");
    render(
      <ThemeProvider forceDefault>
        <div />
      </ThemeProvider>,
    );
    expect(htmlClasses()).toContain("default");
    expect(htmlClasses()).not.toContain("rose");
  });

  it("still respects the OS/browser's dark-mode preference while forced (STEP 5), without ever showing the chosen family", () => {
    localStorage.setItem("tb-theme", "purple-dark");
    mockMatchMedia(true);
    render(
      <ThemeProvider forceDefault>
        <div />
      </ThemeProvider>,
    );
    expect(htmlClasses()).toContain("dark");
    expect(htmlClasses()).toContain("default");
    expect(htmlClasses()).not.toContain("purple");
  });

  it("restores the real selection the instant forceDefault goes back to false — no separate restoration step", () => {
    localStorage.setItem("tb-theme", "teal");
    const { rerender } = render(
      <ThemeProvider forceDefault>
        <div />
      </ThemeProvider>,
    );
    expect(htmlClasses()).not.toContain("teal");
    expect(htmlClasses()).toContain("default");

    rerender(
      <ThemeProvider forceDefault={false}>
        <div />
      </ThemeProvider>,
    );

    expect(htmlClasses()).toContain("teal");
    expect(htmlClasses()).not.toContain("default");
  });

  it("forces default even when nothing at all is stored (a brand-new visitor's own default is already correct, but this must not accidentally break)", () => {
    render(
      <ThemeProvider forceDefault>
        <div />
      </ThemeProvider>,
    );
    expect(htmlClasses()).toContain("default");
  });
});
