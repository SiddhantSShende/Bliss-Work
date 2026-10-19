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
// useOpenTaskDiscussion (the task card's Chat button) reads useSelectedChat;
// this suite exercises neither Chat nor DM navigation, so a plain stub is enough.
vi.mock("../lib/selectedChat", () => ({ useSelectedChat: () => ({ openChat: vi.fn() }) }));

// Stand-in for the people/channel picker (it has its own tests): it hands back one fixed
// target when confirmed, so the test follows Add member all the way to the API call.
vi.mock("../features/AddParticipantsPicker", () => ({
  AddParticipantsPicker: ({ onConfirm }: { onConfirm: (t: { userIds: string[]; channelIds: string[] }) => void }) => (
    <button onClick={() => onConfirm({ userIds: ["55555555-5555-4555-8555-555555555555"], channelIds: [] })}>confirm picker</button>
  ),
}));

import { ProjectAssignedTasks, Tasks } from "./Tasks";

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

const card = (title: string) => screen.getByText(title).closest("[data-task-card]") as HTMLElement;

function mountProject(projectId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectAssignedTasks projectId={projectId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

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

describe("Allocated to me — Add member only, no participants block", () => {
  const TITLES = ["Write the report", "Review the deck", "Plan the offsite"];
  // The one status a card legitimately shows is its own, in the header badge.
  const OWN: Record<string, string> = { "Write the report": "sent", "Review the deck": "acknowledged", "Plan the offsite": "acknowledged" };
  const STATUS_WORDS = ["sent", "acknowledged", "completed", "ignored", "left", "missed"];

  it("renders Add member on every card, enabled", async () => {
    mount();
    await screen.findByText("Write the report");

    for (const title of TITLES) {
      expect(within(card(title)).getByRole("button", { name: "Add member" })).toBeEnabled();
    }
  });

  it("clicking Add member opens the picker, and confirming it adds the people to THAT task", async () => {
    mount();
    await screen.findByText("Write the report");

    fireEvent.click(within(card("Review the deck")).getByRole("button", { name: "Add member" }));
    fireEvent.click(await screen.findByRole("button", { name: "confirm picker" }));

    await waitFor(() =>
      expect(mocks.api.addTaskParticipants).toHaveBeenCalledExactlyOnceWith(B, {
        userIds: ["55555555-5555-4555-8555-555555555555"],
        channelIds: [],
      }),
    );
    expect(mocks.api.taskAction).not.toHaveBeenCalled();
    expect(mocks.api.withdrawTaskParticipant).not.toHaveBeenCalled();
  });

  it("renders no participants: no heading, names, list or the viewer's own row", async () => {
    mount();
    await screen.findByText("Write the report");

    for (const title of TITLES) {
      const c = within(card(title));
      expect(c.queryByText(/participants/i)).toBeNull();
      expect(c.queryByText("piyush")).toBeNull();
      expect(c.queryByText("me")).toBeNull();
      expect(c.queryByRole("list")).toBeNull();
    }
    expect(screen.queryByText("piyush")).toBeNull();
  });

  it("renders no Withdraw — neither the viewer's own nor Withdraw <person>", async () => {
    mount();
    await screen.findByText("Write the report");

    for (const title of TITLES) {
      expect(within(card(title)).queryByRole("button", { name: /withdraw/i })).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /withdraw/i })).toBeNull();
  });

  it("renders no participant status: the only status word on a card is its own header badge", async () => {
    mount();
    await screen.findByText("Write the report");

    for (const title of TITLES) {
      const c = within(card(title));
      for (const word of STATUS_WORDS) {
        // piyush is "acknowledged" on one card and "sent" on another; neither may show up.
        expect(c.queryAllByText(word, { selector: "span" })).toHaveLength(word === OWN[title] ? 1 : 0);
      }
    }
  });

  it("keeps the title, assigned time and deadline on every card", async () => {
    server = server.map((t) => ({ ...t, deadlineAt: "2099-01-01T10:00:00.000Z" }));
    mount();
    await screen.findByText("Write the report");

    for (const title of ["Write the report", "Review the deck", "Plan the offsite"]) {
      const times = within(card(title)).getByTestId("task-times");
      expect(times).toHaveTextContent(/assigned/i);
      expect(times).toHaveTextContent(/deadline/i);
    }
  });

  it("uses the slim two-column body: the side column is the actions, then Add member under them", async () => {
    mount();
    await screen.findByText("Write the report");

    const body = card("Review the deck").firstElementChild as HTMLElement;
    expect(body.className).toContain("14rem");
    const side = body.lastElementChild as HTMLElement;
    expect(within(side).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["Complete", "Leave", "Chat", "Add member"]);

    const sent = card("Write the report").firstElementChild!.lastElementChild as HTMLElement;
    expect(within(sent).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["Acknowledge", "Ignore", "Chat", "Add member"]);
    // Full width, so it reads as part of the action area rather than a stray link.
    expect(within(side).getByRole("button", { name: "Add member" })).toHaveClass("w-full");
  });

  it("Leave runs the existing Leave flow and the card leaves the view", async () => {
    mount();
    await screen.findByText("Review the deck");

    fireEvent.click(within(card("Review the deck")).getByRole("button", { name: "Leave" }));

    await waitFor(() => expect(mocks.api.taskAction).toHaveBeenCalledExactlyOnceWith(B, "leave"));
    await waitFor(() => expect(screen.queryByText("Review the deck")).toBeNull());
    expect(mocks.api.withdrawTaskParticipant).not.toHaveBeenCalled();
    expect(screen.getByText("Write the report")).toBeInTheDocument();
  });

  it("Complete runs the existing Complete flow", async () => {
    mount();
    await screen.findByText("Review the deck");

    fireEvent.click(within(card("Review the deck")).getByRole("button", { name: "Complete" }));

    await waitFor(() => expect(mocks.api.taskAction).toHaveBeenCalledExactlyOnceWith(B, "complete"));
    await waitFor(() => expect(screen.queryByText("Review the deck")).toBeNull());
  });

  it("a rejected Leave rolls the card back, tells the user, and can be retried", async () => {
    mocks.api.taskAction.mockRejectedValueOnce(new ApiError(409, "cannot leave"));
    mount();
    await screen.findByText("Review the deck");

    fireEvent.click(within(card("Review the deck")).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce());
    expect(screen.getByText("Review the deck")).toBeInTheDocument();

    await waitFor(() => expect(within(card("Review the deck")).getByRole("button", { name: "Leave" })).toBeEnabled());
    fireEvent.click(within(card("Review the deck")).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(mocks.api.taskAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Review the deck")).toBeNull());
  });

  it("a SENT card keeps Acknowledge and Ignore", async () => {
    mount();
    await screen.findByText("Write the report");

    fireEvent.click(within(card("Write the report")).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(mocks.api.taskAction).toHaveBeenCalledWith(A, "acknowledge"));
    expect(within(card("Write the report")).getByRole("button", { name: "Ignore" })).toBeInTheDocument();
  });
});

describe("Terminal/archive views (completed/left/ignored/missed) drop the roster", () => {
  // Tasks.tsx: `hideParticipants={view === "allocated" || isTerminalView(view)}` —
  // "the terminal/archive views ... no longer need the roster: no participants
  // block there." Same rule as "Allocated to me" above, which is why this view
  // also switches to the slim, action-only card body (taskCardLayout.ts).
  it("Completed renders no participants: no heading, names, list or withdraw", async () => {
    server = [task(A, "Old job", "COMPLETED")];
    mount("completed");
    await screen.findByText("Old job");

    const c = within(card("Old job"));
    expect(c.queryByText(/participants/i)).toBeNull();
    expect(c.queryByText("piyush")).toBeNull();
    expect(c.queryByRole("button", { name: /withdraw/i })).toBeNull();
  });

  it("Completed uses the slim two-column body, not the full one", async () => {
    server = [task(A, "Old job", "COMPLETED")];
    mount("completed");
    await screen.findByText("Old job");

    expect((card("Old job").firstElementChild as HTMLElement).className).toContain("14rem");
  });
});

describe("Project page — Assigned to you keeps participants, loses only Withdraw", () => {
  const PROJECT = "bbbbbbbb-0000-4000-8000-000000000001";

  beforeEach(() => {
    server = [
      task(A, "Write the report", "SENT", { projectId: PROJECT }),
      // The viewer allocated this one AND is an open assignee on it, so both the
      // allocator's "Withdraw piyush" and the viewer's own "Withdraw" would show
      // elsewhere — neither should show here.
      task(C, "Plan the offsite", "ACKNOWLEDGED", {
        senderId: ME,
        projectId: PROJECT,
        participants: [person(ME, "me", "ACKNOWLEDGED"), person(PIYUSH, "piyush", "SENT")],
      }),
    ];
  });

  it("shows participants, their status and Add member, but no Withdraw button at all", async () => {
    mountProject(PROJECT);
    await screen.findByText("Write the report");

    for (const title of ["Write the report", "Plan the offsite"]) {
      const c = within(card(title));
      expect(c.getByText(/participants/i)).toBeInTheDocument();
      expect(c.getByText("piyush")).toBeInTheDocument();
      expect(c.getByRole("button", { name: "Add member" })).toBeInTheDocument();
      expect(c.queryByRole("button", { name: /withdraw/i })).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /withdraw/i })).toBeNull();
  });

  it("Leave still works on the viewer's own acknowledged row", async () => {
    mountProject(PROJECT);
    await screen.findByText("Plan the offsite");

    fireEvent.click(within(card("Plan the offsite")).getByRole("button", { name: "Leave" }));

    await waitFor(() => expect(mocks.api.taskAction).toHaveBeenCalledExactlyOnceWith(C, "leave"));
    expect(mocks.api.withdrawTaskParticipant).not.toHaveBeenCalled();
  });

  it("Add member still works", async () => {
    mountProject(PROJECT);
    await screen.findByText("Write the report");

    fireEvent.click(within(card("Write the report")).getByRole("button", { name: "Add member" }));
    fireEvent.click(await screen.findByRole("button", { name: "confirm picker" }));

    await waitFor(() =>
      expect(mocks.api.addTaskParticipants).toHaveBeenCalledExactlyOnceWith(A, {
        userIds: ["55555555-5555-4555-8555-555555555555"],
        channelIds: [],
      }),
    );
  });
});
