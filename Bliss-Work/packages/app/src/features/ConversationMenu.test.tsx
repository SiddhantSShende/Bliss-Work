/**
 * The conversation header's overflow menu.
 *
 * Four rules live here that nothing else would catch.
 *
 * The first is the one the feature was specified around: "More" is a DISCLOSURE,
 * not a second popup. Opening it must leave exactly one menu on the page, and
 * closing the menu must collapse it again so it never reopens mid-expansion.
 *
 * The second is that a row with nothing behind it stays INERT and says why —
 * Clear Chat has no bulk endpoint, and neither has Rename or Delete. A row that
 * looks clickable and silently does nothing is worse than no row.
 *
 * The third is the stacking order: this menu opens over a message list full of
 * images, video and map previews, and z-1000 is what keeps it in front of them.
 *
 * The fourth is that the channel group only exists on a channel. A chat has
 * nothing to rename, delete or leave, and offering it would be four dead rows.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationMenu, type ConversationMenuProps } from "./ConversationMenu";

const CHAT_ROWS = ["View Profile", "Search", "Media, Links & Docs", "Mute Notifications", "More"];
const MORE_ROWS = ["Clear Chat", "Export Chat", "Pin Chat"];

function menu(props: Partial<ConversationMenuProps> = {}) {
  const handlers = {
    onViewProfile: vi.fn(),
    onSearch: vi.fn(),
    onMedia: vi.fn(),
    onToggleMute: vi.fn(),
    onToggleShortcut: vi.fn(),
    onExport: vi.fn(),
  };
  render(
    <ConversationMenu scope="chat" muted={false} shortcut={false} {...handlers} {...props} />,
  );
  return handlers;
}

const openMenu = async (name = "Chat options") => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name }));
  return user;
};

const rows = () => screen.getAllByRole("menuitem").map((i) => i.textContent);

describe("ConversationMenu", () => {
  it("is one trigger until it is opened", () => {
    menu();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Chat options" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("offers the five rows, in the order they were specified", async () => {
    menu();
    await openMenu();
    expect(rows()).toEqual(CHAT_ROWS);
  });

  it("expands More INSIDE the same menu rather than opening a second one", async () => {
    menu();
    const user = await openMenu();

    await user.click(screen.getByRole("menuitem", { name: "More" }));

    // The whole point of the requirement: one menu, now longer.
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(rows()).toEqual([...CHAT_ROWS, ...MORE_ROWS]);
    expect(screen.getByRole("menuitem", { name: "More" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("collapses again on a second click, and stays open while it does", async () => {
    menu();
    const user = await openMenu();
    const more = () => screen.getByRole("menuitem", { name: "More" });

    await user.click(more());
    await user.click(more());

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(rows()).toEqual(CHAT_ROWS);
  });

  it("reopens collapsed, so the menu is short until someone asks for the rest", async () => {
    menu();
    let user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "More" }));
    // Close it from the trigger, then come back.
    await user.click(screen.getByRole("button", { name: "Chat options" }));

    user = await openMenu();
    expect(rows()).toEqual(CHAT_ROWS);
  });

  it("routes each primary row to its own handler and closes behind it", async () => {
    const h = menu();
    const cases: [string, keyof typeof h][] = [
      ["View Profile", "onViewProfile"],
      ["Search", "onSearch"],
      ["Media, Links & Docs", "onMedia"],
      ["Mute Notifications", "onToggleMute"],
    ];
    for (const [label, handler] of cases) {
      const user = await openMenu();
      await user.click(screen.getByRole("menuitem", { name: label }));
      expect(h[handler]).toHaveBeenCalledOnce();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    }
  });

  it("exports and toggles the shortcut from inside the expansion", async () => {
    const h = menu();
    let user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Export Chat" }));
    expect(h.onExport).toHaveBeenCalledOnce();

    user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Pin Chat" }));
    expect(h.onToggleShortcut).toHaveBeenCalledOnce();
  });

  it("names the state it would move to, not the state it is in", async () => {
    menu({ muted: true, shortcut: true });
    const user = await openMenu();
    expect(screen.getByRole("menuitem", { name: "Unmute Notifications" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Unpin Chat" })).toBeInTheDocument();
  });

  it("leaves Clear Chat inert while no endpoint backs it, and says why", async () => {
    menu();
    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "More" }));

    const row = screen.getByRole("menuitem", { name: "Clear Chat" });
    expect(row).toBeDisabled();
    // The title rides on the parent: a disabled button fires no mouse events,
    // so its own title would never surface on hover.
    expect(row.parentElement).toHaveAttribute("title", expect.stringContaining("Not available"));
  });

  it("clears the chat once a handler is supplied", async () => {
    const onClearChat = vi.fn();
    menu({ onClearChat });
    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Clear Chat" }));
    expect(onClearChat).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("offers no channel management on a chat", async () => {
    menu();
    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "More" }));
    for (const label of ["Rename", "Delete", "Leave"]) {
      expect(screen.queryByRole("menuitem", { name: label })).not.toBeInTheDocument();
    }
  });

  it("floats the panel at z-1000, above every other layer in the app", async () => {
    menu();
    await openMenu();
    // Images, video and map previews render inside the message list this menu
    // opens over; the tallest z-index anywhere else in the app is z-[200].
    expect(screen.getByRole("menu").className).toMatch(/\bz-\[1000\]/);
  });

  it("closes when the click lands outside it", async () => {
    menu();
    const user = await openMenu();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    const backdrop = document.querySelector('[aria-hidden="true"].fixed');
    expect(backdrop).not.toBeNull();
    // One below the panel, so it dismisses without covering what it guards.
    expect((backdrop as Element).className).toMatch(/\bz-\[999\]/);
    await user.click(backdrop as Element);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

/**
 * The channel form, which is the menu the ChannelMenu component used to be:
 * the same five rows plus the three that manage the channel itself. These
 * assertions are carried over from that component's own tests — the rows moved,
 * the rules they encode did not.
 */
describe("ConversationMenu — channel", () => {
  const channelMenu = (props: Partial<ConversationMenuProps> = {}) => {
    const onLeave = vi.fn();
    menu({ scope: "channel", onLeave, ...props });
    return { onLeave };
  };

  it("adds Rename, Delete and Leave below the shared rows", async () => {
    channelMenu();
    await openMenu("Channel options");
    expect(rows()).toEqual([...CHAT_ROWS, "Rename", "Delete", "Leave"]);
  });

  it("leaves Rename and Delete disabled while no endpoint backs them", async () => {
    channelMenu();
    await openMenu("Channel options");
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Leave" })).toBeEnabled();
  });

  it("says WHY those two are disabled, on a wrapper a disabled button cannot swallow", async () => {
    channelMenu();
    await openMenu("Channel options");
    for (const label of ["Rename", "Delete"]) {
      const row = screen.getByRole("menuitem", { name: label });
      expect(row.parentElement).toHaveAttribute("title", expect.stringContaining("Not available"));
    }
  });

  it("enables them once handlers are supplied, and routes each to its own", async () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    channelMenu({ onRename, onDelete });

    let user = await openMenu("Channel options");
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onRename).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    user = await openMenu("Channel options");
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onRename).toHaveBeenCalledOnce();
  });

  it("leaves the channel and closes behind it", async () => {
    const { onLeave } = channelMenu();
    const user = await openMenu("Channel options");
    await user.click(screen.getByRole("menuitem", { name: "Leave" }));
    expect(onLeave).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("disables only Leave while a leave is in flight", async () => {
    channelMenu({ leaving: true });
    await openMenu("Channel options");
    expect(screen.getByRole("menuitem", { name: "Leaving…" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Search" })).toBeEnabled();
  });
});
