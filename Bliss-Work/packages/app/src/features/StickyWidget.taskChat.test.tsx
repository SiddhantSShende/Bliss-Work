import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { actionsFor, type AssigneeStatus, type StickyTaskDTO } from "@taskboard/shared";
import { StickyWidget } from "./StickyWidget";

const ME = "00000000-0000-4000-8000-000000000001";

function task(status: AssigneeStatus): StickyTaskDTO {
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
    participants: [],
    assignedAt: "2026-09-19T00:00:00.000Z",
    acknowledgedAt: null,
  } as StickyTaskDTO;
}

describe("StickyWidget Chat button", () => {
  it("does not render when onChat is omitted — every existing call site is unaffected", () => {
    render(<StickyWidget task={task("SENT")} onAction={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /chat/i })).not.toBeInTheDocument();
  });

  it("calls onChat, never onAction, when clicked", () => {
    const onAction = vi.fn();
    const onChat = vi.fn();
    render(<StickyWidget task={task("ACKNOWLEDGED")} onAction={onAction} onChat={onChat} />);

    fireEvent.click(screen.getByRole("button", { name: /chat/i }));

    expect(onChat).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("renders alongside every existing action without replacing one", () => {
    render(<StickyWidget task={task("SENT")} onAction={vi.fn()} onChat={vi.fn()} />);

    // Exact names: the card's header X is ALSO an Ignore action, with its own
    // accessible name "Dismiss (ignore)" — a loose /ignore/i would match both.
    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ignore" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument();
  });

  it("shows the unread count as a badge, and nothing when there is none", () => {
    const { rerender } = render(
      <StickyWidget task={task("ACKNOWLEDGED")} onAction={vi.fn()} onChat={vi.fn()} chatUnreadCount={3} />,
    );
    expect(screen.getByRole("button", { name: /chat/i })).toHaveTextContent("3");

    rerender(<StickyWidget task={task("ACKNOWLEDGED")} onAction={vi.fn()} onChat={vi.fn()} chatUnreadCount={0} />);
    expect(screen.getByRole("button", { name: /chat/i })).not.toHaveTextContent(/\d/);
  });

  it("disables the Chat button while chatBusy, independent of the other actions", () => {
    render(<StickyWidget task={task("ACKNOWLEDGED")} onAction={vi.fn()} onChat={vi.fn()} chatBusy />);

    expect(screen.getByRole("button", { name: /chat/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /complete/i })).toBeEnabled();
  });
});
