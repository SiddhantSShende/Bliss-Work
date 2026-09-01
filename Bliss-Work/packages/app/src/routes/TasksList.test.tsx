/**
 * Regression coverage for the Tasks sidebar not clearing task notifications:
 * this panel mounts the instant the Tasks section opens (see AppShell.tsx —
 * it's the <aside> next to Tasks.tsx's <Outlet>, present regardless of which
 * bucket ends up being the default landing view), so it is the right place to
 * clear a task's bell notification just from opening the section — unlike
 * Tasks.tsx's sub-views, which only ever hold one of the two task lists at a
 * time and default to "Allocated to me", not "My tasks" (where
 * TASK_ACKNOWLEDGED/COMPLETED/IGNORED/LEFT notifications actually land).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NotificationDTO, SentTaskDTO, StickyTaskDTO } from "@taskboard/shared";
import { qk } from "../lib/queryBridge";

const SENT_TASK_ID = "018f0000-0000-7000-8000-0000000000a1";
const NOTIF_ID = "018f0000-0000-7000-8000-0000000000b1";

const api = {
  taskAssigned: vi.fn(async () => [] as StickyTaskDTO[]),
  tasksSent: vi.fn(async () => [] as SentTaskDTO[]),
  markNotificationRead: vi.fn(async () => {}),
};
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));
vi.mock("../lib/useAvailability", () => ({ useAvailability: () => ({ roster: [] }) }));

import { TasksList } from "./TasksList";

function sentTask(over: Partial<SentTaskDTO> = {}): SentTaskDTO {
  return {
    taskId: SENT_TASK_ID,
    orgId: "org-1",
    title: "Ship the thing",
    description: "",
    assignees: [],
    ...over,
  } as SentTaskDTO;
}

function notification(over: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id: NOTIF_ID,
    kind: "TASK_COMPLETED",
    text: "Task completed by Jane Okafor",
    taskId: SENT_TASK_ID,
    read: false,
    createdAt: "2026-08-01T09:05:00.000Z",
    ...over,
  };
}

function renderTasksList(notifications: NotificationDTO[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.notifications, notifications);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/app/tasks/allocated"]}>
        <TasksList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc };
}

beforeEach(() => {
  api.markNotificationRead.mockClear();
  api.tasksSent.mockResolvedValue([sentTask()]);
  api.taskAssigned.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("opening the Tasks section clears its bell notifications", () => {
  it("marks a notification for a sent task read as soon as the panel mounts — even while landing on 'Allocated', not 'My tasks'", async () => {
    const { qc } = renderTasksList([notification()]);
    await screen.findByText("My tasks");

    await waitFor(() => expect(api.markNotificationRead).toHaveBeenCalledWith(NOTIF_ID));
    const cached = qc.getQueryData<NotificationDTO[]>(qk.notifications);
    expect(cached?.find((n) => n.id === NOTIF_ID)?.read).toBe(true);
  });

  it("leaves an already-read notification alone", async () => {
    renderTasksList([notification({ read: true })]);
    await screen.findByText("My tasks");

    await Promise.resolve();
    expect(api.markNotificationRead).not.toHaveBeenCalled();
  });

  it("never touches a notification for a task the user has no involvement with", async () => {
    renderTasksList([notification({ taskId: "018f0000-0000-7000-8000-0000000000c9" })]);
    await screen.findByText("My tasks");

    await Promise.resolve();
    expect(api.markNotificationRead).not.toHaveBeenCalled();
  });
});
