/**
 * Clicking a chat, channel or meeting notification lands on the right page and marks
 * it read — including the meeting lifecycle kinds (updated / started / cancelled).
 *
 * Mounted like AppShell mounts it, over real routes, so the router really moves; the
 * mark-read call is the app's own (useNotificationActions) against a stubbed api.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationDTO } from "@taskboard/shared";
import { NotificationsPanel } from "./NotificationsPanel";

const api = {
  markNotificationRead: vi.fn(async (_id: string) => {}),
  readAllNotifications: vi.fn(async () => {}),
  notificationsUnreadCount: vi.fn(async () => ({ unreadCount: 0 })),
};
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));

const CALL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHANNEL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MESSAGE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TASK = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

let n = 0;
const note = (kind: string, text: string, over: Partial<NotificationDTO> = {}): NotificationDTO => {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind, text, taskId: null, read: false,
    createdAt: new Date(Date.UTC(2026, 9, 6, 9, n)).toISOString(),
    ...over,
  };
};

const FEED = { loading: false, hasNextPage: false, isFetchingNextPage: false, loadMore: () => {} };
const Where = () => <output data-testid="where">{useLocation().pathname + useLocation().search}</output>;

function mount(notifications: NotificationDTO[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/app/settings"]}>
        <Routes><Route path="*" element={<div />} /></Routes>
        <Where />
        <NotificationsPanel open onClose={() => {}} notifications={notifications} unreadFeed={FEED} readFeed={FEED} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const where = () => screen.getByTestId("where").textContent;

beforeEach(() => {
  n = 0;
  api.markNotificationRead.mockClear();
});

describe("where a notification takes you, and that it is marked read", () => {
  const cases: { name: string; row: () => NotificationDTO; click: string | RegExp; to: string }[] = [
    { name: "a direct message opens that conversation at the message", row: () => note("DM_MESSAGE", "Priya Shah: Lunch at one?", { conversationId: CHAT, messageId: MESSAGE }),
      click: "Priya Shah", to: `/app/chats/${CHAT}?m=${MESSAGE}` },
    { name: "a channel message opens that channel at the message", row: () => note("CHANNEL_MESSAGE", "Priya Shah in #design: Review is ready", { channelId: CHANNEL, messageId: MESSAGE }),
      click: "Priya Shah · #design", to: `/app/channels/${CHANNEL}?m=${MESSAGE}` },
    { name: "being added to a channel opens the channel", row: () => note("CHANNEL_ADDED", "Priya added you to the channel design", { channelId: CHANNEL }),
      click: /added you to the channel/, to: `/app/channels/${CHANNEL}` },
    { name: "a scheduled meeting opens the meeting", row: () => note("MEETING_SCHEDULED", "Meeting scheduled: Standup", { callId: CALL }),
      click: /Meeting scheduled/, to: `/app/meetings/${CALL}` },
    { name: "an invitation opens the meeting", row: () => note("MEETING_INVITATION", "Meeting invitation: Standup", { callId: CALL }),
      click: /Meeting invitation/, to: `/app/meetings/${CALL}` },
    { name: "an updated meeting opens the meeting", row: () => note("MEETING_UPDATED", "Meeting updated: Standup · 2026-10-07T09:00:00Z", { callId: CALL }),
      click: /Meeting updated/, to: `/app/meetings/${CALL}` },
    { name: "a started meeting opens the meeting", row: () => note("MEETING_STARTED", "Meeting started: Standup", { callId: CALL }),
      click: /Meeting started/, to: `/app/meetings/${CALL}` },
    { name: "a cancelled meeting opens the meetings list (there is no meeting left)", row: () => note("MEETING_CANCELLED", "Meeting cancelled: Standup", { callId: null }),
      click: /Meeting cancelled/, to: "/app/meetings" },
    { name: "a task notification still opens the task", row: () => note("TASK_ASSIGNED", "New task from Priya: Report", { taskId: TASK }),
      click: /New task from/, to: `/app/mail/task/${TASK}` },
  ];

  it.each(cases)("$name", async ({ row, click, to }) => {
    const target = row();
    mount([target, note("TASK_COMPLETED", "an unrelated row", { taskId: TASK })]);
    expect(where()).toBe("/app/settings");

    await userEvent.click(screen.getByText(click));

    expect(where()).toBe(to);
    expect(api.markNotificationRead).toHaveBeenCalledTimes(1);
    expect(api.markNotificationRead).toHaveBeenCalledWith(target.id);
  });

  it("draws every meeting kind as a meeting, and a chat or channel message as chat", () => {
    mount([
      note("MEETING_UPDATED", "Meeting updated: A", { callId: CALL }),
      note("MEETING_STARTED", "Meeting started: B", { callId: CALL }),
      note("MEETING_CANCELLED", "Meeting cancelled: C"),
      note("DM_MESSAGE", "Priya: hi", { conversationId: CHAT }),
    ]);
    const category = (text: string) => screen.getByText(text, { exact: false }).closest("li")!.querySelector("[data-category]")!.getAttribute("data-category");
    expect(category("Meeting updated")).toBe("meeting");
    expect(category("Meeting started")).toBe("meeting");
    expect(category("Meeting cancelled")).toBe("meeting");
    expect(category("Priya")).toBe("chat");
  });
});
