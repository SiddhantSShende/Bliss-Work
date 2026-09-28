/**
 * Settings → Theme menu: exactly one row is ✓, and the custom theme has no name.
 *
 * Runs the real Settings and the real ThemeProvider — only the runtime (which
 * Settings reads for desktop-only bridges) is stubbed — so a selection goes all
 * the way through the provider's state and localStorage and back onto the rows.
 *
 * The regression: activating the custom theme leaves ThemeProvider's `theme`
 * pointing at the preset it was layered over, and the preset rows compared
 * against that alone, so the previous preset AND Custom both showed a ✓.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@taskboard/ui";

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { Settings } from "./Settings";

function renderSettings() {
  render(
    <MemoryRouter>
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    </MemoryRouter>,
  );
  return userEvent.setup();
}

/** Saving the custom theme drops back to the menu still open, so opening is a
 *  no-op when it already is — the trigger toggles. */
async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  if (screen.queryByRole("menu")) return;
  await user.click(screen.getByRole("button", { name: "Change theme" }));
}

/** Names of every ✓ row in the open menu, Light/Dark included. */
const checkedRows = () =>
  within(screen.getByRole("menu"))
    .getAllByRole("menuitemradio", { checked: true })
    .map((row) => row.textContent?.trim());

async function createCustomTheme(user: ReturnType<typeof userEvent.setup>) {
  await openMenu(user);
  await user.click(screen.getByRole("button", { name: "Create custom theme" }));
  await user.click(screen.getByRole("button", { name: "Save theme" }));
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  document.documentElement.className = "";
});

describe("Theme menu selection", () => {
  it("checks only the active preset (plus the Light/Dark mode)", async () => {
    const user = renderSettings();
    await openMenu(user);
    // Default theme is Blue + Purple, in Light mode.
    expect(checkedRows()).toEqual(["Light", "Blue + Purple"]);
  });

  it("moves the ✓ to Custom and off the previous preset when Custom is chosen", async () => {
    const user = renderSettings();
    await createCustomTheme(user);
    await openMenu(user);
    expect(checkedRows()).toEqual(["Light", "Custom"]);
  });

  it("moves the ✓ back to the preset picked after Custom", async () => {
    const user = renderSettings();
    await createCustomTheme(user);
    await openMenu(user);
    await user.click(screen.getByRole("menuitemradio", { name: "Purple" }));
    await openMenu(user);
    expect(checkedRows()).toEqual(["Light", "Purple"]);
  });

  it("re-selecting the saved Custom row activates it again without a second ✓", async () => {
    const user = renderSettings();
    await createCustomTheme(user);
    await openMenu(user);
    await user.click(screen.getByRole("menuitemradio", { name: "Cyan / Teal" }));
    await openMenu(user);
    expect(checkedRows()).toEqual(["Light", "Cyan / Teal"]);
    await user.click(screen.getByRole("menuitemradio", { name: "Custom" }));
    await openMenu(user);
    expect(checkedRows()).toEqual(["Light", "Custom"]);
  });

  it("keeps exactly one accent ✓ in Dark mode too", async () => {
    const user = renderSettings();
    await createCustomTheme(user);
    await openMenu(user);
    await user.click(screen.getByRole("menuitemradio", { name: "Dark" }));
    await openMenu(user);
    expect(checkedRows()).toEqual(["Dark", "Custom"]);
  });

  it("names the active theme 'Custom' in the row description", async () => {
    const user = renderSettings();
    expect(screen.getByText("Currently using Blue + Purple.")).toBeInTheDocument();
    await createCustomTheme(user);
    expect(screen.getByText("Currently using Custom.")).toBeInTheDocument();
  });
});

describe("Selection is explicit, never inferred from the palette", () => {
  it("does not blank every ✓ when storage says Custom is active but no palette exists", async () => {
    // e.g. the palette entry was cleared or corrupted while the flag survived.
    localStorage.setItem("tb-custom-theme-active", "true");
    const user = renderSettings();
    expect(screen.getByText("Currently using Blue + Purple.")).toBeInTheDocument();
    await openMenu(user);
    expect(checkedRows()).toEqual(["Light", "Blue + Purple"]);
    expect(screen.queryByRole("menuitemradio", { name: "Custom" })).not.toBeInTheDocument();
  });

  it("does not blank every ✓ when the stored palette is invalid", async () => {
    localStorage.setItem("tb-custom-theme", JSON.stringify({ colors: ["not-a-colour"] }));
    localStorage.setItem("tb-custom-theme-active", "true");
    const user = renderSettings();
    await openMenu(user);
    expect(checkedRows()).toEqual(["Light", "Blue + Purple"]);
  });

  it("selects Custom by the active flag alone: a palette equal to a preset's colour does not select that preset", async () => {
    // Rose's accent is #e11d48. Custom holding exactly that colour must still
    // read as Custom — the ✓ follows the explicit selection, not the colours.
    localStorage.setItem("tb-theme", "blue");
    localStorage.setItem("tb-custom-theme", JSON.stringify({ colors: ["#e11d48"] }));
    localStorage.setItem("tb-custom-theme-active", "true");
    const user = renderSettings();
    await openMenu(user);
    expect(checkedRows()).toEqual(["Light", "Custom"]);
  });

  it("selects the preset by its id even when a saved palette exists that matches it", async () => {
    localStorage.setItem("tb-theme", "rose");
    localStorage.setItem("tb-custom-theme", JSON.stringify({ colors: ["#e11d48"] }));
    localStorage.setItem("tb-custom-theme-active", "false");
    const user = renderSettings();
    await openMenu(user);
    expect(checkedRows()).toEqual(["Light", "Red / Rose"]);
  });
});

describe("Custom theme editor", () => {
  it("has no name field and saves a name-less theme", async () => {
    const user = renderSettings();
    await openMenu(user);
    await user.click(screen.getByRole("button", { name: "Create custom theme" }));
    expect(screen.queryByPlaceholderText("Theme name")).not.toBeInTheDocument();
    // Saving needs nothing typed — the old name field gated the button.
    expect(screen.getByRole("button", { name: "Save theme" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save theme" }));
    expect(JSON.parse(localStorage.getItem("tb-custom-theme")!)).toEqual({ colors: ["#6366f1"] });
  });

  it("still opens a custom theme saved before the name was removed", async () => {
    localStorage.setItem("tb-custom-theme", JSON.stringify({ name: "Sunset", colors: ["#ff8800", "#aa2200"] }));
    localStorage.setItem("tb-custom-theme-active", "true");
    const user = renderSettings();
    await openMenu(user);
    // Shown as "Custom" — the old name is gone from the UI, not just hidden.
    expect(checkedRows()).toEqual(["Light", "Custom"]);
    expect(screen.queryByText("Sunset")).not.toBeInTheDocument();
  });
});
