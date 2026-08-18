/**
 * The notification bell.
 *
 * The panel used to mark everything read the moment it OPENED. That made it
 * useless for the one thing it exists for: the effect flipped every row to
 * `read` on the same render the panel appeared, `unread` emptied, and the user
 * was left looking at "You're all caught up" — the notifications they opened the
 * bell to read had already moved into "Show read".
 *
 * These tests pin the corrected timing: unread rows stay on screen for as long
 * as the panel is open, and are marked read when it closes.
 *
 * The harness feeds the panel from the react-query cache rather than from a
 * fixed prop, because that is the loop the bug lived in — the panel writes the
 * cache, the cache is what the parent passes back in — and a static prop would
 * hide it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { NotificationDTO } from "@taskboard/shared";

const api = {
  readAllNotifications: vi.fn(async () => {}),
  markNotificationRead: vi.fn(async () => {}),
};

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api, config: { kind: "web" } }),
}));

import { NotificationsPanel } from "./NotificationsPanel";
import { qk } from "../lib/queryBridge";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

const notif = (over: Partial<NotificationDTO> = {}): NotificationDTO => ({
  id: ID,
  kind: "TASK_COMPLETED",
  text: "Task completed by Jane Okafor",
  taskId: null,
  read: false,
  createdAt: new Date(0).toISOString(),
  ...over,
});

/** AppShell in miniature: owns the open flag, feeds the panel from the cache. */
function Harness({ initial }: { initial: NotificationDTO[] }) {
  const [open, setOpen] = useState(true);
  const { data = [] } = useQuery({ queryKey: qk.notifications, queryFn: async () => initial });
  return (
    <>
      <button onClick={() => setOpen(false)}>close the bell</button>
      <NotificationsPanel open={open} onClose={() => setOpen(false)} notifications={data} />
    </>
  );
}

function renderPanel(initial: NotificationDTO[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seeded BEFORE render, because that is the real sequence: the notifications
  // query is loaded long before anyone clicks the bell. Letting it arrive
  // asynchronously instead would leave the panel's first render holding an
  // empty list, which is exactly the case the old mark-on-open effect happened
  // to survive — and would hide the bug these tests exist for.
  qc.setQueryData(qk.notifications, initial);
  render(
    <QueryClientProvider client={qc}>
      <Harness initial={initial} />
    </QueryClientProvider>,
  );
  return { qc };
}

const closeBell = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "close the bell" }));

beforeEach(() => {
  api.readAllNotifications.mockClear();
  api.markNotificationRead.mockClear();
});

describe("NotificationsPanel", () => {
  it("keeps an unread notification on screen and readable while the panel is open", async () => {
    renderPanel([notif()]);

    expect(await screen.findByText("Task completed by Jane Okafor")).toBeTruthy();
    // The regression: the row must not be swept into "Show read" simply because
    // the panel opened, and the server must not have been told it was read.
    expect(screen.queryByText("You're all caught up")).toBeNull();
    expect(api.readAllNotifications).not.toHaveBeenCalled();
  });

  it("marks everything read once the panel closes", async () => {
    const user = userEvent.setup();
    const { qc } = renderPanel([notif()]);
    await screen.findByText("Task completed by Jane Okafor");

    await closeBell(user);

    await waitFor(() => expect(api.readAllNotifications).toHaveBeenCalledTimes(1));
    const cached = qc.getQueryData<NotificationDTO[]>(qk.notifications);
    expect(cached?.every((n) => n.read)).toBe(true);
  });

  it("does not call the server on close when nothing was unread", async () => {
    const user = userEvent.setup();
    renderPanel([notif({ read: true })]);
    await screen.findByRole("button", { name: "Show read (1)" });

    await closeBell(user);

    await waitFor(() => expect(api.readAllNotifications).not.toHaveBeenCalled());
  });

  it("still marks a single notification read on demand, without closing", async () => {
    const user = userEvent.setup();
    renderPanel([notif()]);

    await user.click(await screen.findByRole("button", { name: "Mark read" }));

    expect(api.markNotificationRead).toHaveBeenCalledWith(ID);
    // Now read, so it leaves the unread list — that one WAS the user's request.
    await waitFor(() => expect(screen.getByText("You're all caught up")).toBeTruthy());
  });

  it("renders a channel invitation, the one non-task notification kind", async () => {
    renderPanel([notif({ kind: "CHANNEL_ADDED", text: "You were added to #general" })]);

    expect(await screen.findByText("You were added to #general")).toBeTruthy();
  });
});
