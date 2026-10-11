/**
 * Get App and Invite are icon-only controls in the header — the same IconButton
 * the notification bell uses, so the geometry, focus ring and tooltip behaviour
 * are one definition for every theme (a Custom theme only changes the tokens).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { TopNavbar } from "./TopNavbar";

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: {}, config: { kind: "web" } }) }));
vi.mock("./OrgSwitcher", () => ({ OrgSwitcher: () => <div>org-switcher</div> }));
vi.mock("./ProfileMenu", () => ({ ProfileMenu: () => <div>profile-menu</div> }));
vi.mock("../i18n/LanguageSwitcher", () => ({ LanguageSwitcher: () => <div>language-switcher</div> }));

const Where = () => <span data-testid="where">{useLocation().pathname}</span>;
const renderBar = () =>
  render(
    <MemoryRouter>
      <TopNavbar unread={0} onOpenNotifs={vi.fn()} onOpenDrawer={vi.fn()} />
      <Where />
    </MemoryRouter>,
  );

describe("header Get App and Invite", () => {
  it.each([["Get App"], ["Invite"]])("%s is an icon with a tooltip and an accessible name, not a text pill", (name) => {
    renderBar();
    const button = screen.getByRole("button", { name });
    expect(button).toHaveAttribute("title", name);
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.textContent).toBe("");
  });

  it("share the notification bell's geometry and focus treatment", () => {
    renderBar();
    const bell = screen.getByRole("button", { name: "Notifications" });
    for (const name of ["Get App", "Invite"]) {
      const button = screen.getByRole("button", { name });
      for (const cls of ["h-9", "w-9", "rounded-xl", "focus-visible:ring-2", "focus-visible:ring-accent/40"]) {
        expect(button, `${name} ${cls}`).toHaveClass(cls);
        expect(bell, `bell ${cls}`).toHaveClass(cls);
      }
      // Tinted from the accent TOKENS — no colour is named here.
      expect(button).toHaveClass("bg-accent-soft", "text-accent");
    }
  });

  it("Invite still goes to the invite page", async () => {
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/app/invite");
  });

  it("Get App still opens the platform menu", async () => {
    renderBar();
    const button = screen.getByRole("button", { name: "Get App" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0);
  });
});
