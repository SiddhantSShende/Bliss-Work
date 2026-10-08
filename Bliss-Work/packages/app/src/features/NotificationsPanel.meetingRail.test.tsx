/**
 * Clicking a meeting-invitation notification lands on the MEETING and lights the
 * Meetings rail icon — not Tasks — wherever the user clicked it from.
 *
 * Mounted the way AppShell mounts it: the notification panel beside the rail, the
 * rail's highlighted section derived from the live location with the app's own
 * `railSectionOf`. Starting from a Tasks page is the case that matters, because
 * that is where "it opened Tasks" would show.
 *
 * Task notifications are pinned too, unchanged: they keep their own destination and
 * their own highlight.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationDTO } from "@taskboard/shared";
import { NotificationsPanel } from "./NotificationsPanel";
import { NotificationClickBridge } from "./NotificationClickBridge";
import { Rail } from "../routes/Rail";
import { railSectionOf } from "../lib/section";

const api = {
  markNotificationRead: vi.fn(async (_id: string) => {}),
  readAllNotifications: vi.fn(async () => {}),
  notificationsUnreadCount: vi.fn(async () => ({ unreadCount: 0 })),
};
/** What the desktop shell would call when an OS popup is clicked. */
let osClick: ((click: { notificationId: string; path: string | null }) => void) | null = null;
const config = {
  onNotificationClick: (handler: (click: { notificationId: string; path: string | null }) => void) => {
    osClick = handler;
    return () => {
      osClick = null;
    };
  },
};
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config }) }));
// The rail's profile menu is not under test and pulls in the session store.
vi.mock("./ProfileMenu", () => ({ ProfileMenu: () => null }));

const CALL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

let n = 0;
const note = (kind: string, text: string, over: Partial<NotificationDTO> = {}): NotificationDTO => {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind,
    text,
    taskId: null,
    read: false,
    createdAt: new Date(Date.UTC(2026, 9, 6, 9, n)).toISOString(),
    ...over,
  } as NotificationDTO;
};

const FEED = { loading: false, hasNextPage: false, isFetchingNextPage: false, loadMore: () => {} };

/** AppShell's wiring: the rail highlights whatever `railSectionOf(pathname)` says. */
function Shell({ notifications }: { notifications: NotificationDTO[] }) {
  const loc = useLocation();
  return (
    <>
      <output data-testid="where">{loc.pathname}</output>
      <NotificationClickBridge />
      <Rail section={railSectionOf(loc.pathname)} variant="bottom" />
      <NotificationsPanel open onClose={() => {}} notifications={notifications} unreadFeed={FEED} readFeed={FEED} />
    </>
  );
}

function mount(notifications: NotificationDTO[], from: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[from]}>
        <Routes>
          <Route path="*" element={<Shell notifications={notifications} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const where = () => screen.getByTestId("where").textContent;
/** The titles of the rail buttons that are marked as the current page. */
const activeRail = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-current") === "page")
    .map((b) => b.getAttribute("title"));

beforeEach(() => {
  n = 0;
  api.markNotificationRead.mockClear();
});

describe("a meeting invitation in the bell", () => {
  const FROM = ["/app/tasks/allocated", "/app/mail/task/" + TASK, "/app/settings", "/app/chats"];

  it.each(FROM)("opens the meeting and lights Meetings (not Tasks), clicked from %s", async (from) => {
    mount([note("MEETING_INVITATION", "Meeting invitation: Standup", { callId: CALL })], from);

    await userEvent.click(screen.getByText("Meeting invitation: Standup"));

    expect(where()).toBe(`/app/meetings/${CALL}`);
    expect(activeRail()).toEqual(["Meetings"]);
  });

  it("falls back to the Meetings list, still lighting Meetings, when the record has no call id", async () => {
    mount([note("MEETING_INVITATION", "Meeting invitation: Standup", { callId: null })], "/app/tasks/allocated");

    await userEvent.click(screen.getByText("Meeting invitation: Standup"));

    expect(where()).toBe("/app/meetings");
    expect(activeRail()).toEqual(["Meetings"]);
  });

  it("ignores a task id carried on the record: the kind decides, not the other ids", async () => {
    mount(
      [note("MEETING_INVITATION", "Meeting invitation: Standup", { callId: CALL, taskId: TASK })],
      "/app/tasks/allocated",
    );

    await userEvent.click(screen.getByText("Meeting invitation: Standup"));

    expect(where()).toBe(`/app/meetings/${CALL}`);
    expect(activeRail()).toEqual(["Meetings"]);
  });

  it("marks the invitation read as it navigates", async () => {
    const invitation = note("MEETING_INVITATION", "Meeting invitation: Standup", { callId: CALL });
    mount([invitation], "/app/tasks/allocated");

    await userEvent.click(screen.getByText("Meeting invitation: Standup"));

    expect(api.markNotificationRead).toHaveBeenCalledWith(invitation.id);
  });
});

describe("a click on the desktop popup for a meeting invitation", () => {
  it("opens the meeting and lights Meetings, from the Tasks page", () => {
    const invitation = note("MEETING_INVITATION", "Meeting invitation: Standup", { callId: CALL });
    mount([invitation], "/app/tasks/allocated");
    expect(activeRail()).toEqual(["Tasks"]);

    act(() => osClick?.({ notificationId: invitation.id, path: `/app/meetings/${CALL}` }));

    expect(where()).toBe(`/app/meetings/${CALL}`);
    expect(activeRail()).toEqual(["Meetings"]);
    expect(api.markNotificationRead).toHaveBeenCalledWith(invitation.id);
  });
});

describe("task notifications keep their own destination and highlight", () => {
  it("a task with an id opens the task in Mail, as before", async () => {
    mount([note("TASK_ASSIGNED", "Alex assigned you a task", { taskId: TASK })], "/app/settings");

    await userEvent.click(screen.getByText("Alex assigned you a task"));

    expect(where()).toBe(`/app/mail/task/${TASK}`);
    expect(activeRail()).toEqual(["Mail"]);
  });

  it("a task without an id opens the Tasks list and lights Tasks, as before", async () => {
    mount([note("TASK_COMPLETED", "A task was completed", { taskId: null })], "/app/settings");

    await userEvent.click(screen.getByText("A task was completed"));

    expect(where()).toBe("/app/tasks/allocated");
    expect(activeRail()).toEqual(["Tasks"]);
  });
});
