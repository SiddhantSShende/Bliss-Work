import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { actionsFor, type AssigneeStatus, type StickyTaskDTO } from "@taskboard/shared";
import { StickyWidget } from "./StickyWidget";

/**
 * The card itself says when the task was assigned and — only if it has one — when it
 * is due, so nobody has to open it to find out. A task without a deadline shows no
 * deadline row at all (no empty placeholder); a recurring occurrence shows ITS own
 * resolved deadline (the DTO of an occurrence carries that, so the card needs no
 * special case); a missed task says so, in words as well as colour.
 */
const ASSIGNED = "2026-09-19T10:00:00.000Z";
const DEADLINE = "2026-09-19T16:00:00.000Z";

function task(status: AssigneeStatus, over: Partial<StickyTaskDTO> = {}): StickyTaskDTO {
  return {
    taskId: "aaaaaaaa-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-000000000002",
    title: "Write the report",
    description: "",
    senderId: "00000000-0000-4000-8000-000000000001",
    senderUsername: "sender",
    myStatus: status,
    actions: actionsFor(status),
    statusVersion: 1,
    participants: [],
    assignedAt: ASSIGNED,
    acknowledgedAt: null,
    ...over,
  } as StickyTaskDTO;
}

const times = () => screen.getByTestId("task-times");
const stamps = () => [...times().querySelectorAll("time")].map((t) => t.getAttribute("datetime"));

describe("task card times", () => {
  it("shows the assigned date and time, and a deadline chip when the task has one", () => {
    render(<StickyWidget task={task("SENT", { deadlineAt: DEADLINE })} onAction={vi.fn()} />);

    expect(within(times()).getByText("Assigned")).toBeInTheDocument();
    expect(within(times()).getByText("Deadline")).toBeInTheDocument();
    expect(stamps()).toEqual([ASSIGNED, DEADLINE]);
    // date AND time, in the viewer's own locale — not a bare date
    for (const el of times().querySelectorAll("time")) expect(el.textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it.each([undefined, null])("shows no deadline row at all when the deadline is %s", (deadlineAt) => {
    render(<StickyWidget task={task("SENT", { deadlineAt })} onAction={vi.fn()} />);

    expect(stamps()).toEqual([ASSIGNED]);
    expect(screen.queryByText("Deadline")).not.toBeInTheDocument();
    expect(times()).not.toHaveTextContent(/no deadline|none|—|n\/a/i);
  });

  it("prints a recurring occurrence's own resolved deadline", () => {
    const monday = "2026-09-21T14:00:00.000Z";
    render(<StickyWidget task={task("SENT", { assignedAt: monday, deadlineAt: "2026-09-22T14:00:00.000Z" })} onAction={vi.fn()} />);
    expect(stamps()).toEqual([monday, "2026-09-22T14:00:00.000Z"]);
  });

  it("marks a missed task as missed — badge, chip and no actions — and keeps its original times", () => {
    render(
      <StickyWidget
        task={task("MISSED", { deadlineAt: DEADLINE, missedAt: "2026-09-19T16:00:03.000Z" })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByText("missed")).toBeInTheDocument();
    expect(within(times()).getByText("Missed")).toBeInTheDocument();
    expect(stamps()).toEqual([ASSIGNED, DEADLINE, "2026-09-19T16:00:03.000Z"]);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(document.querySelector(".app-drag")).toHaveClass("border-danger/40");
  });

  it("does not tint a task that is not missed", () => {
    render(<StickyWidget task={task("ACKNOWLEDGED", { deadlineAt: DEADLINE })} onAction={vi.fn()} />);
    expect(document.querySelector(".app-drag")).not.toHaveClass("border-danger/40");
    expect(within(times()).queryByText("Missed")).not.toBeInTheDocument();
  });

  it("keeps the times inside the card: the row wraps, and each chip may shrink and break", () => {
    render(<StickyWidget task={task("SENT", { deadlineAt: DEADLINE })} onAction={vi.fn()} />);

    expect(times()).toHaveClass("flex-wrap", "min-w-0");
    for (const chip of times().children) {
      expect(chip).toHaveClass("min-w-0", "max-w-full");
      expect((chip.lastElementChild as HTMLElement).className).toContain("[overflow-wrap:anywhere]");
    }
  });

  it("is on the floating desktop note too", () => {
    render(<StickyWidget task={task("SENT", { deadlineAt: DEADLINE })} onAction={vi.fn()} compact />);
    expect(stamps()).toEqual([ASSIGNED, DEADLINE]);
  });
});

describe("floating note description", () => {
  const LONG = "Prepare the quarterly compliance report for every regional office. ".repeat(4).trim();

  it("wraps at full size and keeps the Assigned row and both buttons in the card", () => {
    render(<StickyWidget task={task("SENT", { description: LONG })} compact onAction={vi.fn()} />);

    const description = screen.getByText(LONG);
    // jsdom has no layout, so pin the structure the pixels come from (measured in a
    // real browser): text-sm kept, wrapping preserved, and ONE height cap — the old
    // max-h-20 + max-h-16 pair left the cap to stylesheet order.
    expect(description.className).toContain("text-sm");
    expect(description.className).toContain("whitespace-pre-wrap");
    expect(description.className).toContain("max-h-36");
    expect(description.className).not.toMatch(/max-h-(16|20)/);
    expect(times()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /acknowledge/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ignore/i })).toBeInTheDocument();
  });

  it("renders a short description unchanged", () => {
    render(<StickyWidget task={task("SENT", { description: "Send it." })} compact onAction={vi.fn()} />);

    expect(screen.getByText("Send it.")).toBeInTheDocument();
  });
});
