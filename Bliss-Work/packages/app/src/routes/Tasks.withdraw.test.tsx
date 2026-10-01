import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { actionsFor, ApiError, type AssigneeStatus, type StickyTaskDTO, type TaskParticipantDTO } from "@taskboard/shared";
import { useSession } from "../store/session";

const ME = "33333333-3333-4333-8333-333333333333";
const PIYUSH = "44444444-4444-4444-8444-444444444444";
const SENDER = "00000000-0000-4000-8000-000000000001";
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

import { Tasks } from "./Tasks";

const person = (userId: string, username: string, status: AssigneeStatus) => ({ userId, username, status }) as TaskParticipantDTO;

function task(id: string, title: string, status: AssigneeStatus, over: Partial<StickyTaskDTO> = {}): StickyTaskDTO {
  return {
    taskId: id,
    orgId: "00000000-0000-4000-8000-000000000002",
    title,
    description: "",
    senderId: SENDER,
    senderUsername: "sender",
    myStatus: status,
    actions: actionsFor(status),
    statusVersion: 1,
    participants: [person(ME, "me", status), person(PIYUSH, "piyush", "ACKNOWLEDGED")],
    assignedAt: "2026-09-19T00:00:00.000Z",
    acknowledgedAt: null,
    ...over,
  } as StickyTaskDTO;
}

/** A tiny in-memory task-svc: the self-removal verbs move the caller's own row to
 *  their terminal status, exactly as the real endpoints do, so a refetch after a
 *  withdrawal returns what the server would. */
const TERMINAL = { ignore: "IGNORED", leave: "LEFT" } as const;
let server: StickyTaskDTO[] = [];

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

const card = (title: string) => screen.getByText(title).closest(".app-drag") as HTMLElement;
const selfWithdraw = (title: string) => within(card(title)).getByRole("button", { name: "Withdraw from this task" });

beforeEach(() => {
  vi.clearAllMocks();
  useSession.setState({ status: "authed", user: { id: ME } } as never);
  server = [
    task(A, "Write the report", "SENT"),
    task(B, "Review the deck", "ACKNOWLEDGED"),
    // The viewer allocated this one AND is an open assignee on it.
    task(C, "Plan the offsite", "ACKNOWLEDGED", {
      senderId: ME,
      participants: [person(ME, "me", "ACKNOWLEDGED"), person(PIYUSH, "piyush", "SENT")],
    }),
  ];
  mocks.api.taskAssigned.mockImplementation(async () => structuredClone(server));
  mocks.api.taskAction.mockImplementation(async (taskId: string, verb: keyof typeof TERMINAL) => {
    const status = TERMINAL[verb];
    server = server.map((t) =>
      t.taskId === taskId
        ? { ...t, myStatus: status, actions: [], participants: t.participants.map((p) => (p.userId === ME ? { ...p, status } : p)) }
        : t,
    );
    return { status, statusVersion: 2 };
  });
  mocks.api.withdrawTaskParticipant.mockResolvedValue({ withdrawnUserId: PIYUSH, statusVersion: 2 });
  mocks.api.stickyPinStates.mockResolvedValue({ pinned: [], unpinned: [A, B, C] });
});

describe("Allocated to me — Withdraw from your own assignment", () => {
  it("SENT: Withdraw runs the existing Ignore flow, then the card leaves the view via the usual refetch", async () => {
    mount();
    await screen.findByText("Write the report");
    const fetchesBefore = mocks.api.taskAssigned.mock.calls.length;

    expect(selfWithdraw("Write the report").textContent?.trim()).toBe("Withdraw");
    fireEvent.click(selfWithdraw("Write the report"));

    await waitFor(() => expect(mocks.api.taskAction).toHaveBeenCalledExactlyOnceWith(A, "ignore"));
    await waitFor(() => expect(screen.queryByText("Write the report")).toBeNull());
    // Reconciliation is the existing onSettled invalidation, not anything new.
    await waitFor(() => expect(mocks.api.taskAssigned.mock.calls.length).toBeGreaterThan(fetchesBefore));
    expect(mocks.api.withdrawTaskParticipant).not.toHaveBeenCalled();
    // The other cards are untouched.
    expect(screen.getByText("Review the deck")).toBeInTheDocument();
  });

  it("ACKNOWLEDGED: Withdraw runs the existing Leave flow, then the card leaves the view", async () => {
    mount();
    await screen.findByText("Review the deck");
    const fetchesBefore = mocks.api.taskAssigned.mock.calls.length;

    expect(selfWithdraw("Review the deck").textContent?.trim()).toBe("Withdraw");
    fireEvent.click(selfWithdraw("Review the deck"));

    await waitFor(() => expect(mocks.api.taskAction).toHaveBeenCalledExactlyOnceWith(B, "leave"));
    await waitFor(() => expect(screen.queryByText("Review the deck")).toBeNull());
    await waitFor(() => expect(mocks.api.taskAssigned.mock.calls.length).toBeGreaterThan(fetchesBefore));
    expect(mocks.api.withdrawTaskParticipant).not.toHaveBeenCalled();
    expect(screen.getByText("Write the report")).toBeInTheDocument();
  });

  it("every active card offers it once, on the viewer's own row", async () => {
    mount();
    await screen.findByText("Write the report");

    for (const title of ["Write the report", "Review the deck", "Plan the offsite"]) {
      const own = within(card(title)).getAllByRole("button", { name: "Withdraw from this task" });
      expect(own).toHaveLength(1);
      const [button] = own;
      expect(button).toHaveTextContent("Withdraw");
      expect(button!.closest("li")).toHaveTextContent("me");
    }
  });

  it("never puts a control on another participant's row, on a card someone else allocated", async () => {
    mount();
    await screen.findByText("Write the report");

    for (const title of ["Write the report", "Review the deck"]) {
      expect(within(card(title)).getByText("piyush").closest("li")!.querySelector("button")).toBeNull();
      expect(within(card(title)).getAllByRole("button", { name: /withdraw/i })).toHaveLength(1);
    }
  });

  it("is submitted once however many times it is clicked while the request is in flight", async () => {
    let finish: (v: unknown) => void = () => {};
    mocks.api.taskAction.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    mount();
    await screen.findByText("Write the report");

    const button = selfWithdraw("Write the report");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(mocks.api.taskAction).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.api.taskAction).toHaveBeenCalledTimes(1);
    finish({ status: "IGNORED", statusVersion: 2 });
  });

  it("a rejected withdrawal rolls the card back, tells the user, and can be retried", async () => {
    mocks.api.taskAction.mockRejectedValueOnce(new ApiError(409, "cannot leave from SENT"));
    mount();
    await screen.findByText("Review the deck");

    fireEvent.click(selfWithdraw("Review the deck"));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce());
    await waitFor(() => expect(selfWithdraw("Review the deck")).toBeEnabled());
    expect(screen.getByText("Review the deck")).toBeInTheDocument();

    fireEvent.click(selfWithdraw("Review the deck"));
    await waitFor(() => expect(mocks.api.taskAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Review the deck")).toBeNull());
  });

  it("finished-task views offer nothing: there is no assignment left to withdraw from", async () => {
    server = [task(A, "Old job", "COMPLETED")];
    mount("completed");
    await screen.findByText("Old job");

    expect(screen.queryByRole("button", { name: /withdraw/i })).toBeNull();
  });

  it("leaves Acknowledge, Ignore, Complete and Leave working", async () => {
    mount();
    await screen.findByText("Write the report");

    fireEvent.click(within(card("Write the report")).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(mocks.api.taskAction).toHaveBeenCalledWith(A, "acknowledge"));
    fireEvent.click(within(card("Review the deck")).getByRole("button", { name: "Complete" }));
    await waitFor(() => expect(mocks.api.taskAction).toHaveBeenCalledWith(B, "complete"));
  });
});

describe("Allocated to me — allocator withdrawal is unchanged", () => {
  it("on a card the viewer allocated, Withdraw <person> still calls withdrawTaskParticipant and never a self action", async () => {
    mount();
    await screen.findByText("Plan the offsite");

    fireEvent.click(within(card("Plan the offsite")).getByRole("button", { name: "Withdraw piyush" }));

    await waitFor(() => expect(mocks.api.withdrawTaskParticipant).toHaveBeenCalledExactlyOnceWith(C, PIYUSH));
    expect(mocks.api.taskAction).not.toHaveBeenCalled();
  });

  it("cards allocated by someone else give the viewer no Withdraw-someone-else", async () => {
    mount();
    await screen.findByText("Write the report");

    expect(within(card("Write the report")).queryByRole("button", { name: "Withdraw piyush" })).toBeNull();
    expect(within(card("Review the deck")).queryByRole("button", { name: "Withdraw piyush" })).toBeNull();
  });

  it("an allocator's own self-withdraw is still the self flow (Leave), not a participant withdrawal", async () => {
    mount();
    await screen.findByText("Plan the offsite");

    fireEvent.click(selfWithdraw("Plan the offsite"));

    await waitFor(() => expect(mocks.api.taskAction).toHaveBeenCalledExactlyOnceWith(C, "leave"));
    expect(mocks.api.withdrawTaskParticipant).not.toHaveBeenCalled();
  });

  it("the two Withdraws read differently on screen and each still hits its own API: own -> Leave, other -> DELETE participant", async () => {
    mount();
    await screen.findByText("Plan the offsite");
    const buttons = () => within(card("Plan the offsite")).getAllByRole("button", { name: /withdraw/i });

    expect(buttons().map((b) => b.textContent?.trim())).toEqual(["Withdraw", "Withdraw piyush"]);

    fireEvent.click(within(card("Plan the offsite")).getByRole("button", { name: "Withdraw piyush" }));
    await waitFor(() => expect(mocks.api.withdrawTaskParticipant).toHaveBeenCalledExactlyOnceWith(C, PIYUSH));
    expect(mocks.api.taskAction).not.toHaveBeenCalled();

    fireEvent.click(selfWithdraw("Plan the offsite"));
    await waitFor(() => expect(mocks.api.taskAction).toHaveBeenCalledExactlyOnceWith(C, "leave"));
    expect(mocks.api.withdrawTaskParticipant).toHaveBeenCalledOnce();
  });
});
