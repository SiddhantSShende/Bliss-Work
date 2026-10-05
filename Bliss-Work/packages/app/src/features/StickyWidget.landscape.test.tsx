/**
 * The landscape task card (taskCardLayout): on the Tasks screen the title, description
 * and times form one column and the people and actions another beside it. jsdom does
 * not lay anything out, so this pins the STRUCTURE the container queries act on and
 * that nothing the card offered has been lost or moved off the card — the pixels are
 * checked in a real browser. Opt-in: without `landscape` the card is what it was.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { actionsFor, type StickyTaskDTO, type TaskParticipantDTO } from "@taskboard/shared";
import { StickyWidget } from "./StickyWidget";
import {
  TASK_CARD_BODY,
  TASK_CARD_BODY_SLIM,
  TASK_CARD_MAIN,
  TASK_CARD_ROOT,
  TASK_CARD_SIDE,
  TASK_CARD_SIDE_SLIM,
} from "./taskCardLayout";

const ME = "00000000-0000-4000-8000-000000000001";
const SENDER = "00000000-0000-4000-8000-0000000000aa";

const participant = (userId: string, username: string, status: TaskParticipantDTO["status"]) =>
  ({ userId, username, status }) as TaskParticipantDTO;

const task = (over: Partial<StickyTaskDTO> = {}): StickyTaskDTO =>
  ({
    taskId: "aaaaaaaa-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-000000000002",
    title: "Write the report",
    description: "A long description that should be free to use the whole width of the card.",
    senderId: SENDER,
    senderUsername: "sender",
    myStatus: "ACKNOWLEDGED",
    actions: actionsFor("ACKNOWLEDGED"),
    statusVersion: 1,
    participants: [participant(ME, "me", "ACKNOWLEDGED"), participant("u2", "piyush", "SENT")],
    assignedAt: "2026-09-19T10:00:00.000Z",
    deadlineAt: "2026-09-25T10:00:00.000Z",
    acknowledgedAt: null,
    ...over,
  }) as StickyTaskDTO;

function renderCard(props: Partial<React.ComponentProps<typeof StickyWidget>> = {}, t: StickyTaskDTO = task()) {
  const onAction = vi.fn();
  const onWithdrawSelf = vi.fn();
  const onAddParticipants = vi.fn();
  const view = render(
    <StickyWidget
      task={t}
      onAction={onAction}
      currentUserId={ME}
      participantLayout="list"
      onWithdrawSelf={onWithdrawSelf}
      onAddParticipants={onAddParticipants}
      {...props}
    />,
  );
  const card = view.container.querySelector(".app-drag") as HTMLElement;
  return { card, onAction, onWithdrawSelf, onAddParticipants };
}

describe("StickyWidget landscape", () => {
  it("is a container whose body splits into a main column and a side column", () => {
    const { card } = renderCard({ landscape: true });
    expect(card).toHaveClass(...TASK_CARD_ROOT.split(" "), "p-3");
    expect(card).not.toHaveClass("gap-3", "p-4");

    const body = card.firstElementChild as HTMLElement;
    expect(body.className).toBe(TASK_CARD_BODY);
    const main = body.firstElementChild as HTMLElement;
    const side = body.lastElementChild as HTMLElement;
    expect(main.className).toBe(TASK_CARD_MAIN);
    expect(side.className).toBe(TASK_CARD_SIDE);
  });

  it("puts the task in the main column and the people and every action in the side column", () => {
    const { card } = renderCard({ landscape: true });
    const body = card.firstElementChild as HTMLElement;
    const main = body.firstElementChild as HTMLElement;
    const side = body.lastElementChild as HTMLElement;

    expect(within(main).getByText("Write the report")).toBeInTheDocument();
    expect(within(main).getByText(/free to use the whole width/)).toBeInTheDocument();
    expect(within(main).getByTestId("task-times")).toBeInTheDocument();
    expect(within(main).getByText("acknowledged", { selector: "span" })).toBeInTheDocument(); // status badge, in the header

    expect(within(side).getByText("piyush")).toBeInTheDocument();
    expect(within(side).getByRole("button", { name: "Withdraw from this task" })).toBeInTheDocument();
    expect(within(side).getByRole("button", { name: "Add member" })).toBeInTheDocument();
    expect(within(side).getByRole("button", { name: /Complete/ })).toBeInTheDocument();
    expect(within(side).getByRole("button", { name: /Leave/ })).toBeInTheDocument();
    // …and none of those is in the other column.
    expect(within(main).queryByRole("button", { name: /Complete|Leave|Add member|Withdraw/ })).not.toBeInTheDocument();
  });

  it("keeps the action row, its container and its wrapping rules", () => {
    const { card } = renderCard({ landscape: true });
    const row = within(card).getByRole("button", { name: /Complete/ }).parentElement as HTMLElement;
    expect(row).toHaveClass("@container/actions", "flex-wrap", "min-w-0", "shrink-0");
    expect(row).toHaveClass("@min-[34rem]/card:mt-auto"); // foot of its column once beside the main one
  });

  it("keeps the description at the same size and cap — only the line spacing tightens", () => {
    const { card } = renderCard({ landscape: true });
    const description = within(card).getByText(/free to use the whole width/);
    expect(description).toHaveClass("text-sm", "max-h-20", "whitespace-pre-wrap", "leading-normal");
    expect(description).not.toHaveClass("leading-relaxed");
  });

  it("still works: actions fire exactly as before", () => {
    const { card, onAction } = renderCard({ landscape: true });
    within(card).getByRole("button", { name: /Complete/ }).click();
    expect(onAction).toHaveBeenCalledWith("COMPLETE");
  });

  it("a SENT task keeps Acknowledge and Ignore in the side column", () => {
    const { card } = renderCard({ landscape: true }, task({ myStatus: "SENT", actions: actionsFor("SENT") }));
    const side = (card.firstElementChild as HTMLElement).lastElementChild as HTMLElement;
    expect(within(side).getByRole("button", { name: /Acknowledge/ })).toBeInTheDocument();
    expect(within(side).getByRole("button", { name: /Ignore/ })).toBeInTheDocument();
  });

  it("a terminal task has no actions but keeps its history and times", () => {
    const { card } = renderCard(
      { landscape: true },
      task({ myStatus: "MISSED", actions: [], missedAt: "2026-09-25T10:00:02.000Z", participants: [participant(ME, "me", "MISSED")] }),
    );
    expect(card).toHaveClass("border-danger/40");
    expect(within(card).queryByRole("button", { name: /Acknowledge|Ignore|Complete|Leave/ })).not.toBeInTheDocument();
    expect(within(card).getByTestId("task-times")).toHaveTextContent("Missed");
  });

  it("hideParticipants drops the whole block but keeps Add member, under the actions in the slim side column", () => {
    const { card } = renderCard({ landscape: true, hideParticipants: true });
    const body = card.firstElementChild as HTMLElement;
    expect(body.className).toBe(TASK_CARD_BODY_SLIM);
    const main = body.firstElementChild as HTMLElement;
    const side = body.lastElementChild as HTMLElement;
    expect(side.className).toBe(TASK_CARD_SIDE_SLIM);

    expect(within(card).queryByText("piyush")).not.toBeInTheDocument();
    expect(within(card).queryByText(/participants/i)).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Withdraw/ })).not.toBeInTheDocument();
    // Participant status pills are gone too: "acknowledged" is only the card's own header badge.
    expect(within(card).getAllByText("acknowledged", { selector: "span" })).toHaveLength(1);
    expect(within(card).queryByText("sent", { selector: "span" })).not.toBeInTheDocument();
    // What stays: title, description, assigned + deadline times, and the actions.
    expect(within(main).getByText("Write the report")).toBeInTheDocument();
    expect(within(main).getByText(/free to use the whole width/)).toBeInTheDocument();
    expect(within(main).getByTestId("task-times")).toHaveTextContent(/assigned/i);
    expect(within(main).getByTestId("task-times")).toHaveTextContent(/deadline/i);
    expect(within(side).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["Complete", "Leave", "Add member"]);
    const add = within(side).getByRole("button", { name: "Add member" });
    expect(add).toBeEnabled();
    expect(add).toHaveClass("w-full");
    // Centred in the slim column, so no foot-of-column auto margin.
    expect(within(side).getByRole("button", { name: /Complete/ }).parentElement).not.toHaveClass("@min-[34rem]/card:mt-auto");
  });

  it("hideParticipants without landscape: still no names, status or Withdraw, still Add member", () => {
    const { card, onAddParticipants } = renderCard({ hideParticipants: true });
    expect(within(card).queryByText("piyush")).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Withdraw/ })).not.toBeInTheDocument();
    expect(within(card).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["Complete", "Leave", "Add member"]);
    expect(onAddParticipants).not.toHaveBeenCalled(); // opening the picker is not submitting it
  });

  it("is opt-in: without it the card is unchanged — one column of sections, no container", () => {
    const { card } = renderCard();
    expect(card).toHaveClass("gap-3", "p-4");
    expect(card).not.toHaveClass("@container/card");
    expect(card.querySelector(`.${CSS.escape("@container/card")}`)).toBeNull();
    // Header, description, times, participants and the action row are direct children, as before.
    expect(card.children.length).toBeGreaterThanOrEqual(4);
    expect(within(card).getByText(/free to use the whole width/)).toHaveClass("leading-relaxed");
    expect(screen.getByRole("button", { name: /Complete/ }).parentElement?.parentElement).toBe(card);
  });
});
