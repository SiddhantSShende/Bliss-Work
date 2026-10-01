import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { actionsFor, type AssigneeStatus, type StickyTaskDTO } from "@taskboard/shared";
import { StickyWidget } from "./StickyWidget";

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

describe("StickyWidget headerPin", () => {
  it("without it, a SENT card keeps its header Ignore X (other screens are unchanged)", () => {
    const onAction = vi.fn();
    render(<StickyWidget task={task("SENT")} onAction={onAction} />);

    fireEvent.click(screen.getByTitle("Dismiss (ignore)"));

    expect(onAction).toHaveBeenCalledWith("IGNORE");
  });

  it("with it, the corner holds the pin control and no Ignore X", () => {
    render(<StickyWidget task={task("SENT")} onAction={vi.fn()} headerPin={pin} />);

    expect(screen.getByRole("button", { name: "Pin task" })).toBeInTheDocument();
    expect(screen.queryByTitle("Dismiss (ignore)")).toBeNull();
  });

  it("clicking the pin control never fires an action", () => {
    const onAction = vi.fn();
    render(<StickyWidget task={task("SENT")} onAction={onAction} headerPin={pin} />);

    fireEvent.click(screen.getByRole("button", { name: "Pin task" }));

    expect(onAction).not.toHaveBeenCalled();
  });

  it("also replaces the collapse/unpin pair on a locked (pinned, acknowledged) card", () => {
    render(
      <StickyWidget
        task={task("ACKNOWLEDGED")}
        onAction={vi.fn()}
        locked
        onCollapse={vi.fn()}
        onUnpin={vi.fn()}
        headerPin={pin}
      />,
    );

    expect(screen.getByRole("button", { name: "Pin task" })).toBeInTheDocument();
    expect(screen.queryByTitle(/collapse/i)).toBeNull();
  });

  it("leaves the button row — Acknowledge, Ignore, Complete, Leave — exactly as it was", () => {
    const onAction = vi.fn();
    const { unmount } = render(<StickyWidget task={task("SENT")} onAction={onAction} headerPin={pin} />);
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    expect(onAction.mock.calls).toEqual([["ACKNOWLEDGE"], ["IGNORE"]]);
    unmount();

    onAction.mockClear();
    render(<StickyWidget task={task("ACKNOWLEDGED")} onAction={onAction} headerPin={pin} />);
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(onAction.mock.calls).toEqual([["COMPLETE"], ["LEAVE"]]);
  });
});
