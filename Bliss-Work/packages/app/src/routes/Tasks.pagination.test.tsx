/**
 * The archive buckets — Completed, Left, Ignored, Missed — show six tasks a page,
 * newest first, and every bucket's cards land in the one shared grid. Allocated to
 * me is work outstanding and is not paged. Mounts the real Tasks page against a tiny
 * in-memory task-svc.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { actionsFor, type AssigneeStatus, type StickyTaskDTO } from "@taskboard/shared";
import { useSession } from "../store/session";

const ME = "33333333-3333-4333-8333-333333333333";

const h = vi.hoisted(() => ({
  api: {
    taskAssigned: vi.fn(),
    tasksSent: vi.fn(),
    taskAvailability: vi.fn(),
    directory: vi.fn(),
    stickyPinStates: vi.fn(),
    taskAction: vi.fn(),
  },
}));

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
// useOpenTaskDiscussion (the task card's Chat button) reads useSelectedChat;
// this suite exercises neither Chat nor DM navigation, so a plain stub is enough.
vi.mock("../lib/selectedChat", () => ({ useSelectedChat: () => ({ openChat: vi.fn() }) }));

import { TASK_CARD_GRID } from "../features/taskCardLayout";
import { TERMINAL_VIEW_LIMIT } from "./tasksBuckets";
import { Tasks } from "./Tasks";

/** The timestamp each terminal bucket orders by (see terminalAt). */
const reachedAt: Record<string, keyof StickyTaskDTO> = {
  completed: "completedAt",
  left: "leftAt",
  ignored: "ignoredAt",
  missed: "missedAt",
};
const statusOf: Record<string, AssigneeStatus> = { completed: "COMPLETED", left: "LEFT", ignored: "IGNORED", missed: "MISSED" };

/** `n` tasks in `status`; task i reached it on day i, so a higher number is newer. */
function tasks(status: AssigneeStatus, n: number, field?: keyof StickyTaskDTO): StickyTaskDTO[] {
  return Array.from({ length: n }, (_, i) => {
    const day = String(i + 1).padStart(2, "0");
    return {
      taskId: `aaaaaaaa-0000-4000-8000-0000000000${day}`,
      orgId: "00000000-0000-4000-8000-000000000002",
      title: `Task number ${i + 1}`,
      description: "",
      senderId: "00000000-0000-4000-8000-000000000001",
      senderUsername: "sender",
      myStatus: status,
      actions: actionsFor(status),
      statusVersion: 1,
      participants: [],
      assignedAt: "2026-09-01T00:00:00.000Z",
      acknowledgedAt: null,
      ...(field ? { [field]: `2026-09-${day}T12:00:00.000Z` } : {}),
    } as unknown as StickyTaskDTO;
  });
}

function mount(view: string) {
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
}

const cards = () => [...document.querySelectorAll<HTMLElement>("[data-task-card]")];
const titles = () => cards().map((c) => within(c).getByText(/^Task number/).textContent);

beforeEach(() => {
  vi.clearAllMocks();
  useSession.setState({ status: "authed", user: { id: ME, orgId: "org" } } as never);
  h.api.tasksSent.mockResolvedValue([]);
  h.api.taskAvailability.mockResolvedValue({ counts: [], hiddenUserIds: [], canManage: false });
  h.api.directory.mockResolvedValue([]);
  h.api.stickyPinStates.mockResolvedValue({ unpinned: [] });
});

describe("archive buckets page at six", () => {
  it("is six", () => {
    expect(TERMINAL_VIEW_LIMIT).toBe(6);
  });

  for (const view of ["completed", "left", "ignored", "missed"]) {
    it(`${view}: 6 on the first page, the older ones on the second`, async () => {
      h.api.taskAssigned.mockResolvedValue(tasks(statusOf[view]!, 7, reachedAt[view]));
      const user = userEvent.setup();
      mount(view);

      await screen.findByText("Task number 7");
      expect(cards()).toHaveLength(6);
      // Newest first: 7 down to 2, so the oldest (1) is on the next page.
      expect(titles()).toEqual(["7", "6", "5", "4", "3", "2"].map((n) => `Task number ${n}`));
      expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

      await user.click(screen.getByRole("button", { name: "Next" }));
      await screen.findByText("Page 2 of 2");
      await waitFor(() => expect(titles()).toEqual(["Task number 1"]));
      expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    });

    it(`${view}: exactly 6 tasks is one page, no pager`, async () => {
      h.api.taskAssigned.mockResolvedValue(tasks(statusOf[view]!, 6, reachedAt[view]));
      mount(view);
      await screen.findByText("Task number 6");
      expect(cards()).toHaveLength(6);
      expect(screen.queryByText(/Page \d+ of/)).not.toBeInTheDocument();
    });
  }

  it("Allocated to me is not paged: every outstanding task is shown", async () => {
    h.api.taskAssigned.mockResolvedValue(tasks("ACKNOWLEDGED", 8));
    mount("allocated");
    await screen.findByText("Task number 8");
    expect(cards()).toHaveLength(8);
    expect(screen.queryByText(/Page \d+ of/)).not.toBeInTheDocument();
  });
});

describe("every bucket renders its cards into the one shared landscape grid", () => {
  const buckets: [string, AssigneeStatus, keyof StickyTaskDTO | undefined][] = [
    ["allocated", "ACKNOWLEDGED", undefined],
    ["completed", "COMPLETED", "completedAt"],
    ["left", "LEFT", "leftAt"],
    ["ignored", "IGNORED", "ignoredAt"],
    ["missed", "MISSED", "missedAt"],
  ];
  for (const [view, status, field] of buckets) {
    it(view, async () => {
      h.api.taskAssigned.mockResolvedValue(tasks(status, 2, field));
      mount(view);
      await screen.findByText("Task number 2");
      for (const card of cards()) {
        // card → motion wrapper → grid
        expect(card.parentElement?.parentElement?.className).toBe(TASK_CARD_GRID);
        expect(card).toHaveClass("@container/card"); // laid out landscape
      }
    });
  }
});
