/**
 * The panel's two ways of marking read — one row, and everything when it closes
 * — both lower the bell badge, a separate server-side count. Closing while a
 * single "Mark read" is still in flight must not take the same row off it twice,
 * and a failed request must not leave a row looking read that the server still
 * holds unread.
 */
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { NotificationDTO } from "@taskboard/shared";
import { qk } from "../lib/queryKeys";

const api = {
  notifications: vi.fn(async () => [] as NotificationDTO[]),
  notificationsUnreadCount: vi.fn(async () => ({ unreadCount: 0 })),
  markNotificationRead: vi.fn(async (_id: string) => {}),
  readAllNotifications: vi.fn(async () => {}),
};
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));

import { NotificationsPanel } from "./NotificationsPanel";

const notification = (id: string): NotificationDTO => ({
  id,
  kind: "TASK_COMPLETED",
  text: `Task ${id} completed`,
  taskId: "018f0000-0000-7000-8000-0000000000a1",
  read: false,
  createdAt: "2026-08-01T09:05:00.000Z",
});

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** AppShell's wiring: the list and the count as live queries, feeding the panel. */
function Harness({ open }: { open: boolean }) {
  const { data: notifications = [] } = useQuery({ queryKey: qk.notifications, queryFn: () => api.notifications() });
  useQuery({ queryKey: qk.notificationsUnreadCount, queryFn: () => api.notificationsUnreadCount() });
  return <NotificationsPanel open={open} onClose={() => {}} notifications={notifications} />;
}

function setup(list: NotificationDTO[], cachedCount: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(qk.notifications, list);
  qc.setQueryData(qk.notificationsUnreadCount, { unreadCount: cachedCount });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const view = render(<Harness open />, { wrapper });
  const badge = () => qc.getQueryData<{ unreadCount: number }>(qk.notificationsUnreadCount)?.unreadCount;
  const close = () => view.rerender(<Harness open={false} />);
  return { badge, close };
}

describe("NotificationsPanel", () => {
  it("takes a row off the badge once when the panel closes while its Mark read is still in flight", async () => {
    const user = userEvent.setup();
    const inFlight = deferred();
    api.markNotificationRead.mockReturnValue(inFlight.promise);
    api.notificationsUnreadCount.mockReturnValue(new Promise(() => {})); // keep the optimistic value visible
    const { badge, close } = setup([notification("n1"), notification("n2")], 3); // a third, beyond the list's window

    await user.click(screen.getAllByRole("button", { name: "Mark read" })[0]!);
    expect(badge()).toBe(2);

    close(); // the read-all sees only n2 as unread
    expect(badge()).toBe(1);

    await act(async () => inFlight.resolve());
    expect(badge()).toBe(1); // n1 was counted when clicked; the resolved request adds nothing
  });

  it("puts the row back when its Mark read fails, because the server still holds it unread", async () => {
    const user = userEvent.setup();
    const list = [notification("n1"), notification("n2")];
    api.markNotificationRead.mockRejectedValue(new Error("offline"));
    api.notifications.mockResolvedValue(list); // the server's truth: both still unread
    api.notificationsUnreadCount.mockResolvedValue({ unreadCount: 2 });
    const { badge } = setup(list, 2);

    await user.click(screen.getAllByRole("button", { name: "Mark read" })[0]!);

    expect(await screen.findAllByRole("button", { name: "Mark read" })).toHaveLength(2);
    expect(badge()).toBe(2);
  });

  it("leaves the row read and refetches only the count when the request succeeds", async () => {
    const user = userEvent.setup();
    api.markNotificationRead.mockResolvedValue(undefined);
    api.notifications.mockClear();
    api.notificationsUnreadCount.mockClear();
    api.notificationsUnreadCount.mockResolvedValue({ unreadCount: 1 });
    const { badge } = setup([notification("n1"), notification("n2")], 2);

    await user.click(screen.getAllByRole("button", { name: "Mark read" })[0]!);

    await vi.waitFor(() => expect(api.notificationsUnreadCount).toHaveBeenCalledTimes(1));
    expect(badge()).toBe(1);
    expect(screen.getAllByRole("button", { name: "Mark read" })).toHaveLength(1);
    expect(api.notifications).not.toHaveBeenCalled(); // the list itself was not refetched
  });
});
