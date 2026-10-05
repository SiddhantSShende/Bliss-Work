import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { actionsFor, type AssigneeStatus, type StickyTaskDTO, type TaskParticipantDTO } from "@taskboard/shared";
import { StickyWidget } from "./StickyWidget";

/**
 * jsdom has no layout engine, so the pixel result ("Acknowledge" stays whole, inside
 * its button and the card, at 100–125% zoom in the real floating note and in-app) is
 * measured in a real browser. What can be pinned here is the STRUCTURE that makes it
 * hold: the action row wraps, a button's width floors at its own min-content, and the
 * participant controls may shrink and wrap instead of being fixed-width.
 *
 * Two regressions this guards: a `flex-nowrap` row of `basis-0 min-w-0` buttons, where
 * the unbreakable "Acknowledge" spilled out of its button; and its first fix, whose
 * `min-w-[min(max-content,100%)]` is invalid CSS (dropped by the browser), leaving
 * `overflow-wrap: anywhere` free to split the word mid-letter.
 */
const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000009";

function task(status: AssigneeStatus, participants: TaskParticipantDTO[] = []): StickyTaskDTO {
  return {
    taskId: "aaaaaaaa-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-000000000002",
    title: "Write the report",
    description: "",
    senderId: ME,
    senderUsername: "sender",
    myStatus: status,
    actions: actionsFor(status),
    statusVersion: 1,
    participants,
    assignedAt: "2026-09-19T00:00:00.000Z",
    acknowledgedAt: null,
  } as StickyTaskDTO;
}

describe("task card action row", () => {
  it("wraps, so a narrow card puts buttons on their own lines instead of squeezing labels", () => {
    render(<StickyWidget task={task("SENT")} onAction={vi.fn()} />);

    const row = screen.getByRole("button", { name: /Acknowledge/ }).parentElement!;
    expect(row).toHaveClass("flex-wrap");
    expect(row).not.toHaveClass("flex-nowrap");
    expect(row).toContainElement(screen.getByRole("button", { name: /Ignore/ }));
  });

  it.each([
    ["SENT", ["Acknowledge", "Ignore"]],
    ["ACKNOWLEDGED", ["Complete", "Leave"]],
  ] as const)("every %s action is a labelled button whose label can never be split", (status, labels) => {
    render(<StickyWidget task={task(status)} onAction={vi.fn()} />);

    for (const label of labels) {
      const button = screen.getByRole("button", { name: new RegExp(label) });
      expect(button).toHaveTextContent(label); // visible text, not clipped or icon-only
      expect(button).toHaveClass("flex-1", "basis-0", "max-w-full");
      // Width floors at the button's own min-content (the default `min-width: auto` of a
      // flex item) — nothing may override it.
      expect(button.className).not.toMatch(/(^|\s)min-w-/);
      // …and no word may break UNCONDITIONALLY: every break-anywhere class must sit behind
      // the narrow-row variant below, never at the top level.
      expect(button.className).not.toMatch(/(^|\s)(overflow-wrap|break-(words|all)|\[overflow-wrap|\[word-break)/);
    }
  });

  it("breaks a word only as a last resort: below 7rem a button takes its own line first", () => {
    // Below the width the longest label fits in (the Electron minimum window at 200%
    // zoom), "Acknowledge" would otherwise spill out of its button and the card. The break
    // is only allowed together with `basis-full`: on its own, break-anywhere shrinks a
    // button's min-content to one letter and two buttons squeeze side by side, splitting
    // words that would have fitted had they simply stacked — the earlier regression.
    render(<StickyWidget task={task("SENT")} onAction={vi.fn()} />);

    for (const name of [/Acknowledge/, /Ignore/]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveClass("@max-[7rem]/actions:basis-full", "@max-[7rem]/actions:[overflow-wrap:anywhere]");
      expect(button).toHaveClass("@max-[9rem]/actions:px-1.5"); // padding gives way before that
    }
  });

  it("uses no CSS the browser will drop: an intrinsic keyword inside min()/max() is invalid", () => {
    // `min-w-[min(max-content,100%)]` was exactly that: ignored, so `min-width` stayed `auto`
    // and, with `overflow-wrap: anywhere`, "Acknowledge" broke mid-word in a narrow note.
    render(<StickyWidget task={task("SENT")} onAction={vi.fn()} compact />);

    for (const name of [/Acknowledge/, /Ignore/]) {
      expect(screen.getByRole("button", { name }).className).not.toMatch(/(min|max|clamp)\([^)]*(max|min|fit)-content/);
    }
  });

  it("each surface hides the decorative icons at its own width: the floating note under 15rem, an in-app card under 9rem", () => {
    const { container, rerender } = render(<StickyWidget task={task("SENT")} onAction={vi.fn()} compact />);
    const row = screen.getByRole("button", { name: /Acknowledge/ }).parentElement!;

    expect(row).toHaveClass("@container/actions");
    for (const icon of row.querySelectorAll("svg")) expect(icon).toHaveClass("@max-[15rem]/actions:hidden");
    expect(screen.getByRole("button", { name: /Acknowledge/ })).toHaveClass("@max-[15rem]/actions:px-2");

    rerender(<StickyWidget task={task("SENT")} onAction={vi.fn()} />);
    const cardRow = screen.getByRole("button", { name: /Acknowledge/ }).parentElement!;
    // The in-app card measures ITS OWN row too, but only gives anything up at the narrow end;
    // above 9rem it renders exactly as it always did.
    expect(cardRow).toHaveClass("@container/actions");
    for (const icon of cardRow.querySelectorAll("svg")) {
      expect(icon).toHaveClass("@max-[9rem]/actions:hidden");
      expect(icon.getAttribute("class") ?? "").not.toContain("@max-[15rem]");
    }
    expect(screen.getByRole("button", { name: /Acknowledge/ }).className).not.toContain("@max-[15rem]");
    expect(container.querySelectorAll("button svg").length).toBeGreaterThan(0); // icons still rendered, just not hidden
  });

  it("keeps each action's click behaviour", async () => {
    const onAction = vi.fn();
    render(<StickyWidget task={task("SENT")} onAction={onAction} />);

    screen.getByRole("button", { name: /Acknowledge/ }).click();
    screen.getByRole("button", { name: /^Ignore$/ }).click();

    expect(onAction.mock.calls).toEqual([["ACKNOWLEDGE"], ["IGNORE"]]);
  });
});

describe("participant controls inside a card", () => {
  const participants = [
    { userId: ME, username: "me", status: "ACKNOWLEDGED" },
    { userId: OTHER, username: "piyush", status: "SENT" },
  ] as TaskParticipantDTO[];

  it("Withdraw and Add member can shrink to the card and wrap, rather than being fixed-width", () => {
    render(
      <StickyWidget
        task={task("ACKNOWLEDGED", participants)}
        currentUserId={ME}
        participantLayout="list"
        onAction={vi.fn()}
        onAddParticipants={vi.fn(async () => {})}
        onWithdrawParticipant={vi.fn(async () => {})}
      />,
    );

    for (const name of ["Withdraw piyush", "Add member"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveClass("max-w-full");
      expect(button).not.toHaveClass("shrink-0");
    }
    expect(screen.getByRole("button", { name: "Add member" })).toHaveClass("whitespace-normal");
  });
});
