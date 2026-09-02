import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { MessageActions } from "./MessageActions";

/**
 * The forward affordance is a LINK, not a button, and that is load-bearing.
 *
 * Navigation has to be the browser's own response to the click: a scripted
 * window.open after an await is what popup blockers stop, and in Electron an
 * anchor is what routes through setWindowOpenHandler → safeExternalUrl →
 * shell.openExternal instead of opening a renderer window. A refactor that
 * "tidies" this into a button with an onClick would break the feature on every
 * platform at once, and only at runtime — hence these tests.
 */
async function openMenu() {
  await userEvent.click(screen.getByLabelText("Message actions"));
}

describe("MessageActions — forward to WhatsApp", () => {
  const href = "https://wa.me/?text=Ship%20it%20on%20Friday";

  it("offers the action as an anchor pointing at the wa.me link", async () => {
    render(<MessageActions mine={false} forwardHref={href} />);
    await openMenu();

    const link = screen.getByRole("menuitem", { name: /forward to whatsapp/i });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", href);
  });

  it("opens in a new tab without handing the opener to wa.me", async () => {
    render(<MessageActions mine={false} forwardHref={href} />);
    await openMenu();

    const link = screen.getByRole("menuitem", { name: /forward to whatsapp/i });
    expect(link).toHaveAttribute("target", "_blank");
    // noopener matters beyond hygiene: without it the opened page can reach
    // back through window.opener and navigate the app away.
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("records the forward on the same click that navigates", async () => {
    const onForward = vi.fn();
    render(<MessageActions mine={false} forwardHref={href} onForward={onForward} />);
    await openMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /forward to whatsapp/i }));

    expect(onForward).toHaveBeenCalledTimes(1);
  });

  it("hides the action entirely on a surface that does not offer it", async () => {
    render(<MessageActions mine={false} onReply={() => {}} />);
    await openMenu();

    expect(screen.queryByRole("menuitem", { name: /whatsapp/i })).toBeNull();
    // The rest of the menu still works — this is not an all-or-nothing gate.
    expect(screen.getByRole("menuitem", { name: /reply/i })).toBeInTheDocument();
  });
});

/**
 * Who may delete a message for everyone, and who may pin one.
 *
 * In a DM this is simply "the author". A channel widens it — an owner, channel
 * admin or org_admin moderates other people's messages, and pinning is
 * moderator-only because it changes what the whole channel sees. Both are
 * enforced server-side; what these pin down is that the MENU does not offer a
 * capability the caller does not have, because a greyed-out or refused entry
 * reads as a permission you might get, which you never will.
 */
describe("MessageActions — delete for everyone", () => {
  it("offers it on your own message", async () => {
    render(<MessageActions mine onDeleteForAll={() => {}} />);
    await openMenu();
    expect(screen.getByRole("menuitem", { name: /delete for everyone/i })).toBeInTheDocument();
  });

  it("withholds it on someone else's message by default — the DM rule", async () => {
    render(<MessageActions mine={false} onDeleteForAll={() => {}} />);
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: /delete for everyone/i })).toBeNull();
  });

  it("offers it on someone else's message when the caller moderates", async () => {
    // The channel case: canDeleteForAll overrides `mine`.
    render(<MessageActions mine={false} canDeleteForAll onDeleteForAll={() => {}} />);
    await openMenu();
    expect(screen.getByRole("menuitem", { name: /delete for everyone/i })).toBeInTheDocument();
  });

  it("still offers 'Delete for me' to someone who cannot delete for everyone", async () => {
    render(<MessageActions mine={false} onHide={() => {}} onDeleteForAll={() => {}} />);
    await openMenu();
    expect(screen.getByRole("menuitem", { name: /delete for me/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /delete for everyone/i })).toBeNull();
  });
});

/**
 * Neither delete fires on click any more — a confirm step sits in between,
 * shared by "Delete for me" and "Delete for everyone" so a stray tap can
 * never remove a message outright.
 */
describe("MessageActions — delete confirmation", () => {
  it("does not hide the message until the confirm dialog is accepted", async () => {
    const onHide = vi.fn();
    render(<MessageActions mine onHide={onHide} />);
    await openMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /delete for me/i }));

    expect(onHide).not.toHaveBeenCalled();
    expect(screen.getByText("Delete message?")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("does not call onHide when the confirm dialog is cancelled", async () => {
    const onHide = vi.fn();
    render(<MessageActions mine onHide={onHide} />);
    await openMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /delete for me/i }));
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onHide).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Delete message?")).not.toBeInTheDocument());
  });

  it("does not delete for everyone until the confirm dialog is accepted, and says it removes it for everyone", async () => {
    const onDeleteForAll = vi.fn();
    render(<MessageActions mine onDeleteForAll={onDeleteForAll} />);
    await openMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /delete for everyone/i }));

    expect(onDeleteForAll).not.toHaveBeenCalled();
    expect(screen.getByText(/removed for everyone/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(onDeleteForAll).toHaveBeenCalledTimes(1);
  });
});

describe("MessageActions — mark as unread", () => {
  it("offers the action after WhatsApp forwarding and before delete for me", async () => {
    render(
      <MessageActions
        mine={false}
        forwardHref="https://wa.me/"
        onMarkUnread={() => {}}
        onHide={() => {}}
      />,
    );
    await openMenu();

    const items = screen.getAllByRole("menuitem");
    expect(items.map((entry) => entry.textContent?.trim())).toEqual([
      "Forward to WhatsApp",
      "Mark as unread",
      "Delete for me",
    ]);
  });

  it("reports the selected message as unread", async () => {
    const onMarkUnread = vi.fn();
    render(<MessageActions mine={false} onMarkUnread={onMarkUnread} />);
    await openMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /mark as unread/i }));

    expect(onMarkUnread).toHaveBeenCalledTimes(1);
  });
});

describe("MessageActions — pin for everyone", () => {
  it("is absent where pinning does not apply", async () => {
    // DMs pass no onTogglePin at all.
    render(<MessageActions mine onHide={() => {}} />);
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: /pin/i })).toBeNull();
  });

  it("offers Pin on an unpinned message and reports the click", async () => {
    const onTogglePin = vi.fn();
    render(<MessageActions mine={false} onTogglePin={onTogglePin} />);
    await openMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: /pin for everyone/i }));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });

  it("reads Unpin once the message is pinned", async () => {
    render(<MessageActions mine={false} pinned onTogglePin={() => {}} />);
    await openMenu();

    expect(screen.getByRole("menuitem", { name: /unpin for everyone/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^pin for everyone$/i })).toBeNull();
  });
});
