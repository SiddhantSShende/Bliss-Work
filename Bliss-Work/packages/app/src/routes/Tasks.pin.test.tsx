import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  actionsFor,
  ApiError,
  EventType,
  type AssigneeStatus,
  type StickyPinChanged,
  type StickyTaskDTO,
} from "@taskboard/shared";
import { qk } from "../lib/queryKeys";
import { applyStickyPinChanged } from "../lib/stickyPinState";
import { useSession } from "../store/session";

const ME = "33333333-3333-4333-8333-333333333333";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";
const C = "aaaaaaaa-0000-4000-8000-000000000003";

const mocks = vi.hoisted(() => ({
  api: {
    taskAssigned: vi.fn(),
    taskAction: vi.fn(),
    stickyPinStates: vi.fn(),
    stickyPin: vi.fn(),
    stickyUnpin: vi.fn(),
    addTaskParticipants: vi.fn(),
    withdrawTaskParticipant: vi.fn(),
  },
  toastError: vi.fn(),
}));

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: mocks.api, config: { kind: "web" } }),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: mocks.toastError, success: vi.fn() }),
}));
// useOpenTaskDiscussion (the task card's Chat button) reads useSelectedChat;
// this suite exercises neither Chat nor DM navigation, so a plain stub is enough.
vi.mock("../lib/selectedChat", () => ({ useSelectedChat: () => ({ openChat: vi.fn() }) }));

import { Tasks } from "./Tasks";

function task(id: string, title: string, status: AssigneeStatus): StickyTaskDTO {
  return {
    taskId: id,
    orgId: "00000000-0000-4000-8000-000000000002",
    title,
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

function mount(view = "allocated") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/app/tasks/${view}`]}>
        <Routes>
          <Route path="/app/tasks/:view" element={<Tasks />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

/** The whole card for one task: the widest ancestor of its title that still holds
 *  only that task's pin control (its parent is the grid, which holds them all). */
function card(title: string): HTMLElement {
  const pins = (el: HTMLElement) => within(el).queryAllByRole("button", { name: /pin task/i }).length;
  let el: HTMLElement = screen.getByText(title);
  while (el.parentElement && pins(el) === 0) el = el.parentElement;
  while (el.parentElement && pins(el.parentElement) === 1) el = el.parentElement;
  if (pins(el) !== 1) throw new Error(`no card with a pin control for "${title}"`);
  return el;
}
const pinButton = (title: string) => within(card(title)).getByRole("button", { name: /pin task/i });

beforeEach(() => {
  vi.clearAllMocks();
  useSession.setState({ status: "authed", user: { id: ME } } as never);
  mocks.api.taskAssigned.mockResolvedValue([
    task(A, "Write the report", "SENT"),
    task(B, "Review the deck", "ACKNOWLEDGED"),
    task(C, "Plan the offsite", "SENT"),
  ]);
  mocks.api.stickyPinStates.mockResolvedValue({ pinned: [A, B], unpinned: [C] });
  mocks.api.stickyPin.mockImplementation(async (id: string) => ({ taskId: id, state: "PINNED", updatedAt: "now" }));
  mocks.api.stickyUnpin.mockImplementation(async (id: string) => ({ taskId: id, state: "UNPINNED", updatedAt: "now" }));
  mocks.api.taskAction.mockResolvedValue(undefined);
});

describe("Allocated to me — top-right Pin / Unpin", () => {
  it("every active card has a pin control and none has the old X", async () => {
    mount();
    await screen.findByText("Write the report");
    expect(screen.getAllByRole("button", { name: /pin task/i })).toHaveLength(3);
    // The header X was titled with this string; it must be gone from every card
    // (the labelled Ignore button below is titled just "Ignore").
    expect(screen.queryAllByTitle("Dismiss (ignore)")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Ignore" })).toHaveLength(2);
  });

  it("an unpinned task shows an outline Pin; a pinned one shows the active, filled Unpin", async () => {
    mount();
    await screen.findByText("Plan the offsite");
    await waitFor(() => expect(pinButton("Plan the offsite")).toHaveAttribute("aria-label", "Pin task"));

    const unpinned = pinButton("Plan the offsite");
    expect(unpinned).toHaveAttribute("aria-pressed", "false");
    expect(unpinned).toHaveAttribute("title", "Pin task");
    expect(unpinned.querySelector("svg")).toHaveAttribute("fill", "none");

    const pinned = pinButton("Write the report");
    expect(pinned).toHaveAttribute("aria-pressed", "true");
    expect(pinned).toHaveAttribute("aria-label", "Unpin task");
    expect(pinned.querySelector("svg")).toHaveAttribute("fill", "currentColor");
  });

  it("clicking Pin on an unpinned task calls api.stickyPin(taskId) and flips only that card", async () => {
    mount();
    await waitFor(() => expect(pinButton("Plan the offsite")).toHaveAttribute("aria-label", "Pin task"));

    fireEvent.click(pinButton("Plan the offsite"));

    await waitFor(() => expect(mocks.api.stickyPin).toHaveBeenCalledWith(C));
    expect(mocks.api.stickyPin).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(pinButton("Plan the offsite")).toHaveAttribute("aria-label", "Unpin task"));
    // Task A and B were not touched.
    expect(pinButton("Write the report")).toHaveAttribute("aria-label", "Unpin task");
    expect(mocks.api.stickyUnpin).not.toHaveBeenCalled();
  });

  it("clicking Unpin calls api.stickyUnpin(taskId), and the task can then be pinned again", async () => {
    mount();
    await waitFor(() => expect(pinButton("Write the report")).toHaveAttribute("aria-label", "Unpin task"));

    fireEvent.click(pinButton("Write the report"));
    await waitFor(() => expect(mocks.api.stickyUnpin).toHaveBeenCalledWith(A));
    await waitFor(() => expect(pinButton("Write the report")).toHaveAttribute("aria-label", "Pin task"));
    await waitFor(() => expect(pinButton("Write the report")).not.toBeDisabled());

    fireEvent.click(pinButton("Write the report"));
    await waitFor(() => expect(mocks.api.stickyPin).toHaveBeenCalledWith(A));
    await waitFor(() => expect(pinButton("Write the report")).toHaveAttribute("aria-label", "Unpin task"));
  });

  it("a failed Unpin rolls back to pinned and tells the user", async () => {
    mocks.api.stickyUnpin.mockRejectedValue(new ApiError(503, "down"));
    mount();
    await waitFor(() => expect(pinButton("Write the report")).toHaveAttribute("aria-label", "Unpin task"));

    fireEvent.click(pinButton("Write the report"));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("down"));
    await waitFor(() => expect(pinButton("Write the report")).toHaveAttribute("aria-label", "Unpin task"));
  });

  it("a failed Pin rolls back to unpinned", async () => {
    mocks.api.stickyPin.mockRejectedValue(new ApiError(409, "task is no longer open"));
    mount();
    await waitFor(() => expect(pinButton("Plan the offsite")).toHaveAttribute("aria-label", "Pin task"));

    fireEvent.click(pinButton("Plan the offsite"));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("task is no longer open"));
    await waitFor(() => expect(pinButton("Plan the offsite")).toHaveAttribute("aria-label", "Pin task"));
  });

  it("a failure on one task does not undo a change to another", async () => {
    let rejectA: (e: Error) => void = () => {};
    mocks.api.stickyUnpin.mockImplementation(
      (id: string) =>
        id === A
          ? new Promise((_, reject) => (rejectA = reject))
          : Promise.resolve({ taskId: id, state: "UNPINNED", updatedAt: "now" }),
    );
    mount();
    await waitFor(() => expect(pinButton("Write the report")).toHaveAttribute("aria-label", "Unpin task"));

    fireEvent.click(pinButton("Write the report")); // A: left in flight
    fireEvent.click(pinButton("Review the deck")); // B: succeeds meanwhile
    await waitFor(() => expect(pinButton("Review the deck")).toHaveAttribute("aria-label", "Pin task"));

    rejectA(new ApiError(503, "down")); // A fails -> only A rolls back
    await waitFor(() => expect(pinButton("Write the report")).toHaveAttribute("aria-label", "Unpin task"));
    expect(pinButton("Review the deck")).toHaveAttribute("aria-label", "Pin task");
  });

  it("blocks a second request while the first is in flight", async () => {
    let resolve: (v: unknown) => void = () => {};
    mocks.api.stickyUnpin.mockImplementation(() => new Promise((r) => (resolve = r)));
    mount();
    await waitFor(() => expect(pinButton("Write the report")).toHaveAttribute("aria-label", "Unpin task"));

    const btn = pinButton("Write the report");
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);

    await waitFor(() => expect(mocks.api.stickyUnpin).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.api.stickyUnpin).toHaveBeenCalledTimes(1);
    expect(mocks.api.stickyPin).not.toHaveBeenCalled();
    resolve({ taskId: A, state: "UNPINNED", updatedAt: "now" });
    await waitFor(() => expect(pinButton("Write the report")).not.toBeDisabled());
  });

  it("a realtime sticky.pin.changed from another device updates exactly that card", async () => {
    const client = mount();
    await waitFor(() => expect(pinButton("Write the report")).toHaveAttribute("aria-label", "Unpin task"));
    const event = (taskId: string, pinState: "PINNED" | "UNPINNED"): StickyPinChanged => ({
      type: EventType.StickyPinChanged,
      eventId: "e",
      orgId: "o",
      occurredAt: "2026-10-01T00:00:00.000Z",
      assigneeId: ME,
      taskId,
      pinState,
    });
    const ctx = { qc: client, invalidate: vi.fn(), me: ME, hasDesktopBridge: false };

    applyStickyPinChanged(event(A, "UNPINNED"), ctx);
    await waitFor(() => expect(pinButton("Write the report")).toHaveAttribute("aria-label", "Pin task"));
    expect(pinButton("Review the deck")).toHaveAttribute("aria-label", "Unpin task");
    expect(pinButton("Plan the offsite")).toHaveAttribute("aria-label", "Pin task");

    applyStickyPinChanged(event(C, "PINNED"), ctx);
    await waitFor(() => expect(pinButton("Plan the offsite")).toHaveAttribute("aria-label", "Unpin task"));
    expect(pinButton("Write the report")).toHaveAttribute("aria-label", "Pin task");
    expect(client.getQueryData(qk.stickyPinStates)).toMatchObject({ [A]: "UNPINNED", [C]: "PINNED" });
  });

  it("clicking the pin control never calls Ignore or Leave", async () => {
    mount();
    await waitFor(() => expect(pinButton("Write the report")).toHaveAttribute("aria-label", "Unpin task"));

    for (const title of ["Write the report", "Review the deck", "Plan the offsite"]) {
      fireEvent.click(pinButton(title));
      await waitFor(() => expect(pinButton(title)).not.toBeDisabled());
    }

    expect(mocks.api.taskAction).not.toHaveBeenCalled();
  });

  it("the bottom Ignore and Leave buttons still do their jobs", async () => {
    mount();
    await screen.findByText("Write the report");

    fireEvent.click(within(card("Write the report")).getByRole("button", { name: "Ignore" }));
    await waitFor(() => expect(mocks.api.taskAction).toHaveBeenCalledWith(A, "ignore"));

    fireEvent.click(within(card("Review the deck")).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(mocks.api.taskAction).toHaveBeenCalledWith(B, "leave"));
  });

  it("Acknowledge and Complete are unchanged", async () => {
    mount();
    await screen.findByText("Write the report");

    fireEvent.click(within(card("Write the report")).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(mocks.api.taskAction).toHaveBeenCalledWith(A, "acknowledge"));

    fireEvent.click(within(card("Review the deck")).getByRole("button", { name: "Complete" }));
    await waitFor(() => expect(mocks.api.taskAction).toHaveBeenCalledWith(B, "complete"));
  });

  it("finished-task views have no pin control", async () => {
    mocks.api.taskAssigned.mockResolvedValue([task(A, "Old job", "COMPLETED")]);
    mount("completed");
    await screen.findByText("Old job");
    expect(screen.queryByRole("button", { name: /pin task/i })).toBeNull();
  });
});
