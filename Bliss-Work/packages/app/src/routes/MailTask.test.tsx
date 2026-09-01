/**
 * Regression coverage for opening a task from the unified inbox: it already
 * cleared the inbox badge (readInboxItem) but left a bell notification about
 * the same task lit until the user explicitly opened the bell panel and
 * clicked "Mark read" — see NotificationsPanel.tsx, which was the only place
 * that ever wrote notification-svc's read state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NotificationDTO, StickyTaskDTO } from "@taskboard/shared";
import { qk } from "../lib/queryBridge";

const TASK_ID = "018f0000-0000-7000-8000-0000000000a1";
const NOTIF_ID = "018f0000-0000-7000-8000-0000000000b1";

const dismissSticky = vi.fn();
const api = {
  taskInbox: vi.fn(async () => [] as StickyTaskDTO[]),
  taskDetail: vi.fn(),
  taskAction: vi.fn(),
  readInboxItem: vi.fn(async () => {}),
  markNotificationRead: vi.fn(async () => {}),
};
// `dismissSticky` is deliberately no longer part of PlatformConfig — it is
// passed here anyway so that if anyone reintroduces the field AND a call to it,
// the assertions below see it rather than silently passing.
vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api, config: { dismissSticky } }),
}));

import { MailTask } from "./MailTask";

function task(over: Partial<StickyTaskDTO> = {}): StickyTaskDTO {
  return {
    taskId: TASK_ID,
    orgId: "org-1",
    title: "Ship the thing",
    description: "",
    senderId: "u-someone",
    senderUsername: "someone",
    myStatus: "ACKNOWLEDGED",
    actions: ["COMPLETE"],
    statusVersion: 1,
    assignedAt: "2026-08-01T09:00:00.000Z",
    acknowledgedAt: "2026-08-01T09:00:00.000Z",
    reviewRating: null,
    ...over,
  } as StickyTaskDTO;
}

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

function renderTask(notifications: NotificationDTO[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.inbox, [task()]);
  qc.setQueryData(qk.notifications, notifications);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/app/mail/task/${TASK_ID}`]}>
        <Routes>
          <Route path="/app/mail/task/:taskId" element={<MailTask />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => {
  api.markNotificationRead.mockClear();
  api.readInboxItem.mockClear();
  dismissSticky.mockClear();
  window.localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("opening a task clears its bell notification", () => {
  it("marks a matching unread notification read as soon as the task opens", async () => {
    const qc = renderTask([notification()]);
    await screen.findByText("Ship the thing");

    await waitFor(() => expect(api.markNotificationRead).toHaveBeenCalledWith(NOTIF_ID));
    const cached = qc.getQueryData<NotificationDTO[]>(qk.notifications);
    expect(cached?.find((n) => n.id === NOTIF_ID)?.read).toBe(true);
  });

  it("leaves an already-read notification alone", async () => {
    renderTask([notification({ read: true })]);
    await screen.findByText("Ship the thing");

    // Give the effect a tick to (not) fire before asserting the negative.
    await waitFor(() => expect(api.readInboxItem).toHaveBeenCalled());
    expect(api.markNotificationRead).not.toHaveBeenCalled();
  });

  it("never touches a notification about a different task", async () => {
    renderTask([notification({ id: "other-notif", taskId: "018f0000-0000-7000-8000-0000000000c9" })]);
    await screen.findByText("Ship the thing");

    await waitFor(() => expect(api.readInboxItem).toHaveBeenCalled());
    expect(api.markNotificationRead).not.toHaveBeenCalled();
  });
});

/**
 * THE "READING IS NOT DEALING WITH IT" REGRESSION.
 *
 * This effect used to clear the task's floating desktop note as well as its
 * badge, and because that clearing was PERSISTED, clicking a task's row in the
 * inbox retired its note for good while the task was still outstanding. A note
 * is a commitment marker; only Completing, Ignoring or Leaving removes it.
 */
describe("opening a task does NOT unpin its sticky note", () => {
  it("never asks the desktop to clear the note", async () => {
    renderTask([]);
    await screen.findByText("Ship the thing");

    // Wait for the effect to have run to completion before asserting a negative.
    await waitFor(() => expect(api.readInboxItem).toHaveBeenCalledWith("TASK", TASK_ID));
    expect(dismissSticky).not.toHaveBeenCalled();
  });

  it("writes nothing to the web sticky's persisted state", async () => {
    renderTask([]);
    await screen.findByText("Ship the thing");

    await waitFor(() => expect(api.readInboxItem).toHaveBeenCalledWith("TASK", TASK_ID));
    // The old code persisted the dismissal here, which is what made it survive
    // every refresh. Nothing about reading a task belongs in local storage.
    expect(window.localStorage.getItem("tb.browser-stickies.unpinned.v1")).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it("still clears the unread badge — that part was always right", async () => {
    renderTask([notification()]);
    await screen.findByText("Ship the thing");

    await waitFor(() => expect(api.readInboxItem).toHaveBeenCalledWith("TASK", TASK_ID));
    await waitFor(() => expect(api.markNotificationRead).toHaveBeenCalledWith(NOTIF_ID));
  });
});
