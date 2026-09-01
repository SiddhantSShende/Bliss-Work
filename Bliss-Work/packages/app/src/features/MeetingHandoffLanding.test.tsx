/**
 * Regression test: the Join Meeting page rendered its own `<GetAppButton />`
 * AND relied on `AuthLayout`'s built-in one, so "Get the desktop app" (with
 * all three OS downloads) showed up twice on the page. `AuthLayout` is shared
 * by seven other auth routes that depend on its copy, so the fix removes the
 * page-local one here rather than AuthLayout's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MeetingHandoffLanding } from "./MeetingHandoffLanding";

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ config: { kind: "web" } }) }));

describe("MeetingHandoffLanding", () => {
  let originalUserAgent: string;

  beforeEach(() => {
    // A mobile UA skips the taskboard:// deep-link attempt (window.location.href
    // assignment isn't meaningful in jsdom) without touching the download UI.
    originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", { value: "iPhone", configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(navigator, "userAgent", { value: originalUserAgent, configurable: true });
  });

  it("shows exactly one 'Get the desktop app' section", () => {
    render(
      <MemoryRouter>
        <MeetingHandoffLanding token="test-token" />
      </MemoryRouter>,
    );

    expect(screen.getAllByText("Get the desktop app")).toHaveLength(1);
    // The link's accessible name comes from its visible text content (OS name
    // + extension), not its `title` attribute, since content takes priority
    // in accessible-name computation whenever both are present.
    expect(screen.getByRole("link", { name: /Windows/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /macOS/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Linux/ })).toBeInTheDocument();
  });

  it("keeps the Continue in Browser button", () => {
    render(
      <MemoryRouter>
        <MeetingHandoffLanding token="test-token" />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Continue in Browser" })).toBeInTheDocument();
  });
});
