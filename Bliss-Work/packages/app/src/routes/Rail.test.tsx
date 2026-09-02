/**
 * Section navigation, in its three shapes — desktop side rail, phone bottom
 * bar, and the mobile drawer's full list. All three read the same nav items
 * and call the same `nav()`; what these tests pin down is the one place they
 * genuinely diverge: the bottom bar's 5-primary-plus-More split, since eight
 * icons in one row is the "squeezed desktop density onto a phone" problem the
 * responsive redesign exists to fix.
 */
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Rail } from "./Rail";

const nav = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => nav };
});

function renderRail(props: Partial<React.ComponentProps<typeof Rail>> = {}) {
  return render(
    <MemoryRouter>
      <Rail section={null} {...props} />
    </MemoryRouter>,
  );
}

describe("Rail — bottom tab bar", () => {
  it("shows exactly the five primary sections plus More, not all eight", () => {
    renderRail({ variant: "bottom" });
    for (const label of ["Mail", "Meetings", "Chats", "Tasks", "Channels", "More"]) {
      expect(screen.getByRole("button", { name: new RegExp(label, "i") })).toBeInTheDocument();
    }
    for (const label of ["Members", "Org", "Settings"]) {
      expect(screen.queryByRole("button", { name: new RegExp(`^${label}$`, "i") })).not.toBeInTheDocument();
    }
  });

  it("opens a popup with the overflow items when More is tapped", async () => {
    renderRail({ variant: "bottom" });
    expect(screen.queryByRole("menuitem", { name: /members/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /more/i }));
    expect(screen.getByRole("menuitem", { name: /members/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^org$/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /settings/i })).toBeInTheDocument();
  });

  it("navigates and closes the popup when an overflow item is picked", async () => {
    renderRail({ variant: "bottom" });
    await userEvent.click(screen.getByRole("button", { name: /more/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /settings/i }));

    expect(nav).toHaveBeenCalledWith("/app/settings");
    expect(screen.queryByRole("menuitem", { name: /settings/i })).not.toBeInTheDocument();
  });

  it("renders More in the active state when the current section is one of its items", () => {
    renderRail({ variant: "bottom", section: "org" });
    // Active styling is the same gradient class RailBtn applies to any
    // selected item — checked here rather than a screenshot since that's the
    // actual signal a user reads as "I'm in a More section".
    expect(screen.getByRole("button", { name: /more/i }).className).toContain("bg-gradient-to-br");
  });
});

describe("Rail — drawer", () => {
  it("lists every section, unlike the bottom bar", () => {
    renderRail({ variant: "drawer" });
    for (const label of ["Mail", "Meetings", "Chats", "Tasks", "Channels", "Members", "Org", "Settings"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("navigates and calls onSelect, so the drawer can close itself", async () => {
    const onSelect = vi.fn();
    renderRail({ variant: "drawer", onSelect });
    await userEvent.click(screen.getByRole("button", { name: "Chats" }));

    expect(nav).toHaveBeenCalledWith("/app/chats");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
