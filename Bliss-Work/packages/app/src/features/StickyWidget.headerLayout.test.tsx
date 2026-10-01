import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { actionsFor, type AssigneeStatus, type StickyTaskDTO } from "@taskboard/shared";
import { StickyWidget } from "./StickyWidget";

/**
 * jsdom has no layout engine, so the widths themselves are measured in a real
 * browser (see the verification notes). What can be pinned here is the
 * STRUCTURE that makes the layout responsive: with a pin control the header is
 * a card-width-driven container (so the title keeps room), and without one it is
 * byte-for-byte the header every other screen already had.
 */
function task(status: AssigneeStatus): StickyTaskDTO {
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
    assignedAt: "2026-09-19T00:00:00.000Z",
    acknowledgedAt: null,
  } as StickyTaskDTO;
}

const pin = <button aria-label="Pin task">pin</button>;

describe("StickyWidget header layout", () => {
  it("with a pin control, the header sizes itself by the card's width (a container query), not the viewport", () => {
    const { container } = render(<StickyWidget task={task("ACKNOWLEDGED")} onAction={vi.fn()} headerPin={pin} />);

    const header = container.querySelector(".\\@container");
    expect(header).not.toBeNull();
    // Title, status badge and pin are all inside it — nothing is dropped.
    expect(header).toContainElement(screen.getByText("Write the report"));
    expect(header).toContainElement(screen.getByText("acknowledged"));
    expect(header).toContainElement(screen.getByRole("button", { name: "Pin task" }));
  });

  it("keeps the status badge text whole and lets it shrink rather than overflow", () => {
    render(<StickyWidget task={task("ACKNOWLEDGED")} onAction={vi.fn()} headerPin={pin} />);

    const text = screen.getByText("acknowledged");
    expect(text).toHaveClass("truncate");
    expect(text.parentElement).toHaveClass("min-w-0", "max-w-full");
  });

  it("without a pin control the header is unchanged: no container wrapper, status badge beside the Ignore X", () => {
    const { container } = render(<StickyWidget task={task("SENT")} onAction={vi.fn()} />);

    expect(container.querySelector(".\\@container")).toBeNull();
    const ignoreX = screen.getByTitle("Dismiss (ignore)");
    expect(ignoreX.parentElement).toContainElement(screen.getByText("sent"));
  });

  it("the compact desktop note is unchanged too", () => {
    const { container } = render(<StickyWidget task={task("ACKNOWLEDGED")} onAction={vi.fn()} compact onCollapse={vi.fn()} onUnpin={vi.fn()} />);

    expect(container.querySelector(".\\@container")).toBeNull();
    expect(screen.getByTitle(/collapse/i)).toBeInTheDocument();
  });
});
