/**
 * Where a click on a notification lands, from wherever the user already is.
 *
 * The panel is mounted OUTSIDE the routes, exactly as AppShell does it, over
 * real `:channelId` routes — so these prove the router actually moves to the
 * notification's own channel, not merely that `navigate` was called with it.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { NotificationDTO } from "@taskboard/shared";
import { NotificationsPanel } from "./NotificationsPanel";

const api = {
  markNotificationRead: vi.fn(async (_id: string) => {}),
  readAllNotifications: vi.fn(async () => {}),
  notificationsUnreadCount: vi.fn(async () => ({ unreadCount: 0 })),
};
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));

const CHANNEL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHANNEL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHANNEL_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const channelAdded = (id: string, channelId: string | null, text: string): NotificationDTO => ({
  id,
  kind: "CHANNEL_ADDED",
  text,
  taskId: null,
  channelId,
  read: false,
  createdAt: "2026-10-01T12:00:00.000Z",
});

const FEED = { loading: false, hasNextPage: false, isFetchingNextPage: false, loadMore: () => {} };

function Where() {
  const loc = useLocation();
  return (
    <>
      <output data-testid="path">{loc.pathname}</output>
      <output data-testid="nav-type">{useNavigationType()}</output>
    </>
  );
}

function Shell({ notifications, entry }: { notifications: NotificationDTO[]; entry: string[] }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={entry} initialIndex={entry.length - 1}>
        <Routes>
          <Route path="/app/channels/:channelId" element={<div>channel view</div>} />
          <Route path="/app/settings" element={<div>settings view</div>} />
          <Route path="*" element={<div>other</div>} />
        </Routes>
        <Where />
        <NotificationsPanel open onClose={() => {}} notifications={notifications} unreadFeed={FEED} readFeed={FEED} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const path = () => screen.getByTestId("path").textContent;

describe("clicking a notification in the bell", () => {
  const notifications = [
    channelAdded("n-a", CHANNEL_A, "Jordan Doe added you to the channel alpha"),
    channelAdded("n-c", CHANNEL_C, "Priya Shah added you to the channel gamma"),
  ];

  it("opens the notification's channel while another channel is open", async () => {
    render(<Shell notifications={notifications} entry={[`/app/channels/${CHANNEL_B}`]} />);
    expect(path()).toBe(`/app/channels/${CHANNEL_B}`);

    await userEvent.click(screen.getByText("Jordan Doe added you to the channel alpha"));

    expect(path()).toBe(`/app/channels/${CHANNEL_A}`);
  });

  it("opens the notification's channel from the Settings page", async () => {
    render(<Shell notifications={notifications} entry={["/app/settings"]} />);

    await userEvent.click(screen.getByText("Jordan Doe added you to the channel alpha"));

    expect(path()).toBe(`/app/channels/${CHANNEL_A}`);
  });

  it("uses each notification's own channel on repeated clicks", async () => {
    render(<Shell notifications={notifications} entry={[`/app/channels/${CHANNEL_B}`]} />);

    await userEvent.click(screen.getByText("Jordan Doe added you to the channel alpha"));
    expect(path()).toBe(`/app/channels/${CHANNEL_A}`);

    await userEvent.click(screen.getByText("Priya Shah added you to the channel gamma"));
    expect(path()).toBe(`/app/channels/${CHANNEL_C}`);

    await userEvent.click(screen.getByText("Jordan Doe added you to the channel alpha"));
    expect(path()).toBe(`/app/channels/${CHANNEL_A}`);
  });

  it("takes the destination from the record's channelId, never from its text", async () => {
    const lookalike = channelAdded("n-x", CHANNEL_A, `Mallory added you to the channel /app/channels/${CHANNEL_B}`);
    render(<Shell notifications={[lookalike]} entry={["/app/settings"]} />);

    await userEvent.click(screen.getByText(/Mallory added you/));

    expect(path()).toBe(`/app/channels/${CHANNEL_A}`);
  });

  it("falls back to the channels section when the record carries no channel", async () => {
    render(<Shell notifications={[channelAdded("n-n", null, "Someone added you")]} entry={[`/app/channels/${CHANNEL_B}`]} />);

    await userEvent.click(screen.getByText("Someone added you"));

    expect(path()).toBe("/app/channels");
  });

  it("does not stack a history entry when the target is already open", async () => {
    render(<Shell notifications={notifications} entry={["/app/settings", `/app/channels/${CHANNEL_A}`]} />);

    await userEvent.click(screen.getByText("Jordan Doe added you to the channel alpha"));

    expect(path()).toBe(`/app/channels/${CHANNEL_A}`);
    expect(screen.getByTestId("nav-type").textContent).toBe("REPLACE");
  });
});
