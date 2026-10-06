import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { actionsFor, type StickyTaskDTO } from "@taskboard/shared";
import { StickyWidget } from "./StickyWidget";

/**
 * On Windows Chromium reports `-webkit-app-region: drag` to the OS as title bar,
 * and the OS does not deliver Precision Touchpad two-finger scrolling over it. So
 * only the floating desktop note — a window of its own that has to be draggable —
 * may be a drag region; an in-app card in the Tasks list must not be, or the list
 * cannot be touchpad-scrolled while the pointer is over a card.
 */
const task = {
  taskId: "aaaaaaaa-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000002",
  title: "Write the report",
  description: "",
  senderId: "00000000-0000-4000-8000-000000000001",
  senderUsername: "sender",
  myStatus: "SENT",
  actions: actionsFor("SENT"),
  statusVersion: 1,
  participants: [],
  assignedAt: "2026-09-19T10:00:00.000Z",
  acknowledgedAt: null,
} as StickyTaskDTO;

describe("task card drag region", () => {
  it.each([
    ["in-app card", {}],
    ["landscape in-app card", { landscape: true }],
  ])("the %s is not a drag region", (_name, props) => {
    const { container } = render(<StickyWidget task={task} onAction={vi.fn()} {...props} />);
    expect(container.querySelector("[data-task-card]")).not.toHaveClass("app-drag");
  });

  it("the floating desktop note is the drag region", () => {
    const { container } = render(<StickyWidget task={task} onAction={vi.fn()} compact />);
    expect(container.querySelector("[data-task-card]")).toHaveClass("app-drag");
  });
});
