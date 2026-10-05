/**
 * TopNavbar in the desktop app (config.windowControls): the window's single
 * header — draggable, no Invite, native-control theme reported — while the web
 * build keeps its Invite button and is not a drag region.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TopNavbar } from "./TopNavbar";

const h = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: {}, config: h.config }) }));
// Their own behaviour (org list, session, theme) is not under test here.
vi.mock("./OrgSwitcher", () => ({ OrgSwitcher: () => <div>org-switcher</div> }));
vi.mock("./ProfileMenu", () => ({ ProfileMenu: () => <div>profile-menu</div> }));
vi.mock("../i18n/LanguageSwitcher", () => ({ LanguageSwitcher: () => <div>language-switcher</div> }));

const setTheme = vi.fn();
const renderBar = (onOpenNotifs = vi.fn()) =>
  render(
    <MemoryRouter>
      <TopNavbar unread={3} onOpenNotifs={onOpenNotifs} onOpenDrawer={vi.fn()} />
    </MemoryRouter>,
  );

describe("TopNavbar", () => {
  beforeEach(() => {
    setTheme.mockClear();
  });

  describe("desktop", () => {
    beforeEach(() => {
      h.config = { kind: "electron", windowControls: { side: "right", setTheme } };
    });

    it("is a drag region and offers no Invite", () => {
      renderBar();
      expect(screen.getByRole("banner")).toHaveClass("app-drag", "app-titlebar");
      expect(screen.queryByRole("button", { name: /invite/i })).toBeNull();
    });

    it("keeps search, notifications, language, org and profile, each outside the drag region", async () => {
      const onOpenNotifs = vi.fn();
      renderBar(onOpenNotifs);
      const search = screen.getByPlaceholderText(/search people/i);
      expect(search.closest(".app-no-drag")).not.toBeNull();
      const bell = screen.getByTitle("Notifications");
      expect(bell.closest(".app-no-drag")).not.toBeNull();
      await userEvent.click(bell);
      expect(onOpenNotifs).toHaveBeenCalledTimes(1);
      for (const id of ["org-switcher", "profile-menu", "language-switcher"]) {
        expect(screen.getByText(id).closest(".app-no-drag")).not.toBeNull();
      }
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("tells the host which colours the native controls should use", () => {
      renderBar();
      expect(setTheme).toHaveBeenCalledWith({
        color: expect.any(String),
        symbolColor: expect.any(String),
      });
    });
  });

  describe("web", () => {
    beforeEach(() => {
      h.config = { kind: "web" };
    });

    it("keeps the Invite button and is not a drag region", () => {
      renderBar();
      expect(screen.getByRole("button", { name: /invite/i })).toBeInTheDocument();
      expect(screen.getByRole("banner")).not.toHaveClass("app-drag");
      expect(setTheme).not.toHaveBeenCalled();
    });
  });
});
