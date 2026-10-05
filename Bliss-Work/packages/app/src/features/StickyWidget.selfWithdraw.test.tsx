import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { actionsFor, type AssigneeStatus, type StickyTaskDTO, type TaskParticipantDTO } from "@taskboard/shared";
import { StickyWidget } from "./StickyWidget";

const ME = "00000000-0000-4000-8000-000000000001";
const SENDER = "00000000-0000-4000-8000-0000000000aa";
const PIYUSH = "00000000-0000-4000-8000-000000000002";
const DIVYA = "00000000-0000-4000-8000-000000000003";

const participant = (userId: string, username: string, status: AssigneeStatus) =>
  ({ userId, username, status }) as TaskParticipantDTO;

function task(status: AssigneeStatus, over: Partial<StickyTaskDTO> = {}): StickyTaskDTO {
  return {
    taskId: "aaaaaaaa-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-000000000002",
    title: "Write the report",
    description: "",
    senderId: SENDER,
    senderUsername: "sender",
    myStatus: status,
    actions: actionsFor(status),
    statusVersion: 1,
    participants: [participant(ME, "me", status), participant(PIYUSH, "piyush", "ACKNOWLEDGED"), participant(DIVYA, "divya", "SENT")],
    assignedAt: "2026-09-19T00:00:00.000Z",
    acknowledgedAt: null,
    ...over,
  } as StickyTaskDTO;
}

const SELF = { name: "Withdraw from this task" };
const rowOf = (name: string) => screen.getByText(name).closest("li") as HTMLElement;

/** `onWithdrawSelf` is what a screen passes to turn the control on; the card hands
 *  it the existing self-removal action and the screen runs it through the same
 *  mutation its Ignore / Leave buttons use (see Tasks.withdraw.test.tsx). */
function renderCard(t: StickyTaskDTO, props: Partial<React.ComponentProps<typeof StickyWidget>> = {}) {
  const onAction = vi.fn();
  const onWithdrawSelf = vi.fn();
  render(
    <StickyWidget task={t} onAction={onAction} onWithdrawSelf={onWithdrawSelf} currentUserId={ME} participantLayout="list" {...props} />,
  );
  return { onAction, onWithdrawSelf };
}

describe("StickyWidget Withdraw on the viewer's own assignment", () => {
  it("SENT: Withdraw hands the existing Ignore action to the screen — and nothing else", () => {
    const { onAction, onWithdrawSelf } = renderCard(task("SENT"));

    const button = within(rowOf("me")).getByRole("button", SELF);
    expect(button.textContent?.trim()).toBe("Withdraw"); // exactly "Withdraw": no name, no suffix
    fireEvent.click(button);

    expect(onWithdrawSelf.mock.calls).toEqual([["IGNORE"]]);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("ACKNOWLEDGED: Withdraw hands the existing Leave action to the screen — and nothing else", () => {
    const { onAction, onWithdrawSelf } = renderCard(task("ACKNOWLEDGED"));

    const button = within(rowOf("me")).getByRole("button", SELF);
    expect(button.textContent?.trim()).toBe("Withdraw"); // exactly "Withdraw": no name, no suffix
    fireEvent.click(button);

    expect(onWithdrawSelf.mock.calls).toEqual([["LEAVE"]]);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("is on the viewer's row only: other participants get no Withdraw", () => {
    renderCard(task("SENT"));

    expect(screen.getAllByRole("button", { name: /withdraw/i })).toHaveLength(1);
    for (const other of ["piyush", "divya"]) expect(within(rowOf(other)).queryByRole("button")).toBeNull();
  });

  it("is off unless the screen passes onWithdrawSelf (the desktop note and the inbox card pass nothing)", () => {
    renderCard(task("SENT"), { onWithdrawSelf: undefined });
    expect(screen.queryByRole("button", { name: /withdraw/i })).toBeNull();
  });

  it.each(["COMPLETED", "LEFT", "IGNORED"] as const)("is gone once the task is %s (no valid action left)", (status) => {
    renderCard(task(status, { actions: actionsFor(status), participants: [participant(ME, "me", "SENT")] }));
    // Even a participants row that still reads open (it lags the card until the
    // refetch lands) offers nothing: with no valid action there is nothing to hand over.
    expect(screen.queryByRole("button", { name: /withdraw/i })).toBeNull();
  });

  it("is disabled while an action on this card is in flight", () => {
    const { onWithdrawSelf } = renderCard(task("SENT"), { busy: true });

    const button = screen.getByRole("button", SELF);
    expect(button).toBeDisabled();
    fireEvent.click(button);

    expect(onWithdrawSelf).not.toHaveBeenCalled();
  });

  it("leaves Acknowledge and Ignore exactly as they were, going through onAction", () => {
    const { onAction, onWithdrawSelf } = renderCard(task("SENT"));

    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));

    expect(onAction.mock.calls).toEqual([["ACKNOWLEDGE"], ["IGNORE"]]);
    expect(onWithdrawSelf).not.toHaveBeenCalled();
  });

  it("an acknowledged card keeps its Complete and Leave buttons next to the new Withdraw", () => {
    const { onAction, onWithdrawSelf } = renderCard(task("ACKNOWLEDGED"));

    fireEvent.click(screen.getByRole("button", { name: "Complete" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));

    expect(onAction.mock.calls).toEqual([["COMPLETE"], ["LEAVE"]]);
    expect(onWithdrawSelf).not.toHaveBeenCalled();
  });
});

describe("StickyWidget allocator withdrawal is unchanged", () => {
  const allocated = () =>
    task("ACKNOWLEDGED", { senderId: ME, participants: [participant(ME, "me", "ACKNOWLEDGED"), participant(PIYUSH, "piyush", "SENT")] });

  it("an allocator withdraws someone else through onWithdrawParticipant — not onAction, not onWithdrawSelf", () => {
    const onWithdrawParticipant = vi.fn(async () => {});
    const { onAction, onWithdrawSelf } = renderCard(allocated(), { onWithdrawParticipant });

    fireEvent.click(screen.getByRole("button", { name: "Withdraw piyush" }));

    expect(onWithdrawParticipant).toHaveBeenCalledExactlyOnceWith(PIYUSH);
    expect(onAction).not.toHaveBeenCalled();
    expect(onWithdrawSelf).not.toHaveBeenCalled();
  });

  it("without onWithdrawSelf, an allocator's own row still has no control", () => {
    renderCard(allocated(), { onWithdrawParticipant: vi.fn(async () => {}), onWithdrawSelf: undefined });

    expect(within(rowOf("me")).queryByRole("button")).toBeNull();
    expect(screen.getAllByRole("button", { name: /withdraw/i }).map((b) => b.getAttribute("aria-label"))).toEqual(["Withdraw piyush"]);
  });
});

describe("StickyWidget Withdraw labels on a card the viewer allocated and is assigned to", () => {
  const card = (status: AssigneeStatus) =>
    task(status, { senderId: ME, participants: [participant(ME, "me", status), participant(PIYUSH, "piyush", "SENT")] });
  const visible = (b: HTMLElement) => b.textContent?.trim();

  it.each([
    ["SENT", "IGNORE"],
    ["ACKNOWLEDGED", "LEAVE"],
  ] as const)("%s: own row reads \"Withdraw\" and still hands %s to the screen; the other row reads \"Withdraw piyush\" and still calls onWithdrawParticipant", (status, action) => {
    const onWithdrawParticipant = vi.fn(async () => {});
    const { onAction, onWithdrawSelf } = renderCard(card(status), { onWithdrawParticipant });

    expect(screen.getAllByRole("button", { name: /withdraw/i }).map(visible)).toEqual(["Withdraw", "Withdraw piyush"]);

    fireEvent.click(within(rowOf("me")).getByRole("button", SELF));
    expect(onWithdrawSelf.mock.calls).toEqual([[action]]);
    expect(onWithdrawParticipant).not.toHaveBeenCalled();

    fireEvent.click(within(rowOf("piyush")).getByRole("button", { name: "Withdraw piyush" }));
    expect(onWithdrawParticipant).toHaveBeenCalledExactlyOnceWith(PIYUSH);
    expect(onWithdrawSelf).toHaveBeenCalledOnce();
    expect(onAction).not.toHaveBeenCalled();
  });
});
