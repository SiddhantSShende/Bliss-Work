/**
 * Modal / Sheet behavior.
 *
 * Every dialog in the app inherits from these two, so a regression here is a
 * regression everywhere. The scroll fix was previously only verifiable by
 * grepping the built CSS for the arbitrary Tailwind class — that proved the
 * rule was EMITTED, not that the component still asks for it, and said nothing
 * at all about the keyboard behavior.
 */
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal, Sheet } from "./Modal";

describe("Modal", () => {
  it("renders nothing when closed", () => {
    render(
      <Modal open={false} onClose={() => {}} title="Hidden">
        <p>body</p>
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("exposes itself as a modal dialog to assistive tech", () => {
    render(
      <Modal open onClose={() => {}} title="Create task">
        <p>body</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Create task");
  });

  it("caps its height and scrolls the BODY, not the page", () => {
    // The backdrop is `fixed inset-0` over a `position:fixed` shell, so the page
    // behind cannot scroll. Without a capped, scrollable body a tall dialog runs
    // off-screen with its submit button unreachable — which is what this fixes.
    render(
      <Modal open onClose={() => {}} title="Tall">
        <button type="button">Submit</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("max-h-[calc(100dvh-2rem)]");
    expect(dialog.className).toContain("flex-col");

    const body = screen.getByText("Submit").parentElement!;
    expect(body.className).toContain("overflow-y-auto");
    // min-h-0 is what actually lets a flex child shrink below its content size;
    // without it overflow-y-auto never engages.
    expect(body.className).toContain("min-h-0");
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="X">
        <p>body</p>
      </Modal>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the backdrop is clicked but not the panel", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="X">
        <p>inside</p>
      </Modal>,
    );

    await userEvent.click(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog on open", async () => {
    render(
      <Modal open onClose={() => {}} title="X">
        <button type="button">First</button>
        <button type="button">Second</button>
      </Modal>,
    );
    await waitFor(() => expect(screen.getByText("First")).toHaveFocus());
  });

  it("traps Tab inside the dialog", async () => {
    render(
      <Modal open onClose={() => {}} title="X">
        <button type="button">First</button>
        <button type="button">Last</button>
      </Modal>,
    );
    const first = screen.getByText("First");
    const last = screen.getByText("Last");
    await waitFor(() => expect(first).toHaveFocus());

    await userEvent.tab();
    expect(last).toHaveFocus();

    // Past the end wraps to the start instead of escaping to the page behind.
    await userEvent.tab();
    expect(first).toHaveFocus();

    // …and Shift+Tab wraps backwards.
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it("restores focus to the trigger on close", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Modal open={open} onClose={() => setOpen(false)} title="X">
            <button type="button">Inside</button>
          </Modal>
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByText("Open");

    await userEvent.click(trigger);
    await waitFor(() => expect(screen.getByText("Inside")).toHaveFocus());

    await userEvent.keyboard("{Escape}");
    // Without this a keyboard user is dumped back at the top of the document.
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("does not steal focus back to the first field when the caller passes a fresh onClose closure every render", async () => {
    // Mirrors real callers like SendCallLinkDialog/AddPeopleDialog, which pass
    // `onClose={busy ? () => {} : onClose}` — a NEW function every render.
    // onClose used to be a dependency of the focus-trap effect, so typing
    // into the second field — which, as a CONTROLLED input, re-renders the
    // parent on every keystroke the same way a real form does — re-ran the
    // whole "focus the first focusable element" setup each time, making it
    // impossible to type past the first character of any field but the first.
    function Harness() {
      const [busy] = useState(false);
      const [second, setSecond] = useState("");
      const onClose = () => {};
      return (
        <Modal open onClose={busy ? () => {} : onClose} title="X">
          <input aria-label="First" />
          <input aria-label="Second" value={second} onChange={(e) => setSecond(e.target.value)} />
        </Modal>
      );
    }
    render(<Harness />);
    const second = screen.getByLabelText("Second");
    await waitFor(() => expect(screen.getByLabelText("First")).toHaveFocus());

    second.focus();
    await userEvent.type(second, "hello");

    expect(second).toHaveFocus();
    expect(second).toHaveValue("hello");
  });

  it("still closes on Escape after the caller's onClose reference has changed", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <Modal open onClose={first} title="X">
        <p>body</p>
      </Modal>,
    );
    rerender(
      <Modal open onClose={second} title="X">
        <p>body</p>
      </Modal>,
    );

    await userEvent.keyboard("{Escape}");

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("renders without a title", () => {
    render(
      <Modal open onClose={() => {}}>
        <p>untitled body</p>
      </Modal>,
    );
    expect(screen.getByText("untitled body")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("Sheet", () => {
  it("gets the same dialog semantics and scroll treatment", () => {
    render(
      <Sheet open onClose={() => {}} title="Details">
        <p>sheet body</p>
      </Sheet>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Details");

    const body = screen.getByText("sheet body").parentElement!;
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).toContain("min-h-0");
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="X">
        <p>body</p>
      </Sheet>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("slides in from the right by default", () => {
    render(
      <Sheet open onClose={() => {}} title="X">
        <p>body</p>
      </Sheet>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("border-l");
    expect(dialog.parentElement!.className).toContain("justify-end");
  });

  it("slides in from the left when side=\"left\" — the mobile nav drawer's convention", () => {
    render(
      <Sheet open onClose={() => {}} title="X" side="left">
        <p>body</p>
      </Sheet>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("border-r");
    expect(dialog.parentElement!.className).toContain("justify-start");
  });
});
