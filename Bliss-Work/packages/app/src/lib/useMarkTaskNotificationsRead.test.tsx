/**
 * Regression coverage for the Tasks list page not clearing task notifications:
 * MailTask.tsx already solved this for the single-task detail view (see its
 * own test file, routes/MailTask.test.tsx) — this hook generalizes the same
 * fix to a list of tasks, for Tasks.tsx (AssignedBucket and MyTasks), so the
 * bell clears just by visiting the Tasks page instead of requiring the user
 * to open the drawer and click "Mark read" on each row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApiClient, NotificationDTO } from "@taskboard/shared";
import { qk } from "./queryBridge";
import { useMarkTaskNotificationsRead } from "./useMarkTaskNotificationsRead";

const TASK_ID = "018f0000-0000-7000-8000-0000000000a1";
const OTHER_TASK_ID = "018f0000-0000-7000-8000-0000000000c9";
const NOTIF_ID = "018f0000-0000-7000-8000-0000000000b1";

const api = {
  markNotificationRead: vi.fn(async () => {}),
} as unknown as ApiClient;

function notification(over: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id: NOTIF_ID,
    kind: "TASK_COMPLETED",
    text: "Task completed by Jane Okafor",
    taskId: TASK_ID,
    read: false,
    createdAt: "2026-08-01T09:05:00.000Z",
    ...over,
  };
}

function renderMarkTaskNotificationsRead(notifications: NotificationDTO[], tasks: { taskId: string }[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.notifications, notifications);
  renderHook(() => useMarkTaskNotificationsRead(api, tasks), {
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });
  return { qc };
}

beforeEach(() => {
  vi.mocked(api.markNotificationRead).mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useMarkTaskNotificationsRead", () => {
  it("marks a matching unread notification read as soon as its task is in the list", async () => {
    const { qc } = renderMarkTaskNotificationsRead([notification()], [{ taskId: TASK_ID }]);

    await waitFor(() => expect(api.markNotificationRead).toHaveBeenCalledWith(NOTIF_ID));
    const cached = qc.getQueryData<NotificationDTO[]>(qk.notifications);
    expect(cached?.find((n) => n.id === NOTIF_ID)?.read).toBe(true);
  });

  it("leaves an already-read notification alone", async () => {
    renderMarkTaskNotificationsRead([notification({ read: true })], [{ taskId: TASK_ID }]);

    await Promise.resolve();
    expect(api.markNotificationRead).not.toHaveBeenCalled();
  });

  it("never touches a notification for a task not in the list", async () => {
    renderMarkTaskNotificationsRead([notification({ taskId: OTHER_TASK_ID })], [{ taskId: TASK_ID }]);

    await Promise.resolve();
    expect(api.markNotificationRead).not.toHaveBeenCalled();
  });

  it("does nothing when no tasks are loaded yet", async () => {
    renderMarkTaskNotificationsRead([notification()], []);

    await Promise.resolve();
    expect(api.markNotificationRead).not.toHaveBeenCalled();
  });
});
