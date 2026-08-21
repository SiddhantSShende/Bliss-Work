/**
 * Tests for the shared popup dismissal rules (usePopupDismiss.ts).
 *
 * The three the chat and channel surfaces were getting wrong, each of which had
 * shipped as a visible bug:
 *
 *   • an outside click closes the popup, and a click INSIDE it does not — the
 *     part a click-away backdrop got right
 *   • pressing the trigger again closes rather than reopening, which is what
 *     breaks when the trigger is treated as "outside"
 *   • opening one popup closes any other, so two panels are never on screen at
 *     once — the part a backdrop could never do, because it only ever knew
 *     about its own menu
 *
 * Driven through real components and real DOM events rather than by calling the
 * hook directly: every one of these rules is about what an event listener on
 * `document` does, and a test that pokes the hook's return value would assert
 * nothing about that.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { usePopupDismiss } from "./usePopupDismiss";

function Popup({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const wrap = usePopupDismiss<HTMLDivElement>(open, () => setOpen(false));
  return (
    <div ref={wrap}>
      <button type="button" onClick={() => setOpen((v) => !v)}>
        open {name}
      </button>
      {open && (
        <div role="menu" aria-label={name}>
          <button type="button">inside {name}</button>
        </div>
      )}
    </div>
  );
}

describe("usePopupDismiss", () => {
  it("closes on a click outside", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Popup name="a" />
        <button type="button">elsewhere</button>
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "open a" }));
    expect(screen.getByRole("menu", { name: "a" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("menu", { name: "a" })).not.toBeInTheDocument();
  });

  it("stays open when the click lands inside the panel", async () => {
    const user = userEvent.setup();
    render(<Popup name="a" />);

    await user.click(screen.getByRole("button", { name: "open a" }));
    await user.click(screen.getByRole("button", { name: "inside a" }));

    expect(screen.getByRole("menu", { name: "a" })).toBeInTheDocument();
  });

  // The trigger lives INSIDE the wrapper precisely so this works: treated as
  // an outside click it would close the popup a moment before the button's own
  // onClick toggled it back open, leaving a control that visibly does nothing.
  it("closes when the trigger is pressed again", async () => {
    const user = userEvent.setup();
    render(<Popup name="a" />);
    const trigger = screen.getByRole("button", { name: "open a" });

    await user.click(trigger);
    expect(screen.getByRole("menu", { name: "a" })).toBeInTheDocument();

    await user.click(trigger);
    expect(screen.queryByRole("menu", { name: "a" })).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<Popup name="a" />);

    await user.click(screen.getByRole("button", { name: "open a" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu", { name: "a" })).not.toBeInTheDocument();
  });

  it("leaves only the newest popup open", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Popup name="a" />
        <Popup name="b" />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "open a" }));
    expect(screen.getByRole("menu", { name: "a" })).toBeInTheDocument();

    // One click, not two. The backdrop this replaced would have absorbed this
    // one closing "a", leaving "b" needing a second press.
    await user.click(screen.getByRole("button", { name: "open b" }));
    expect(screen.getByRole("menu", { name: "b" })).toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "a" })).not.toBeInTheDocument();
  });

  it("stops listening once closed, so a later click cannot reach a stale handler", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Popup name="a" />
        <button type="button">elsewhere</button>
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "open a" }));
    await user.keyboard("{Escape}");
    // Reopening has to work: a registration that was not cleaned up would have
    // left this popup asking itself to close on the next open.
    await user.click(screen.getByRole("button", { name: "open a" }));

    expect(screen.getByRole("menu", { name: "a" })).toBeInTheDocument();
  });
});
