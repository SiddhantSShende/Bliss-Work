/**
 * Opening a chat or a channel reads THAT one's notifications — the same rule the
 * Tasks section follows. Mounts the real DMView / ChannelView; only the runtime is
 * stubbed, and every call the views make to the notification service is recorded so
 * the test can say what was NOT called as precisely as what was.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({
  channel: { id: "ch-1", name: "ops", memberCount: 3, createdBy: "boss" } as unknown as ChannelDTO,
  conversation: { id: "cv-1", peerId: "peer", peerName: "Sam" } as unknown,
  notificationCalls: [] as { name: string; args: unknown[] }[],
  selectedId: "cv-1" as string | null,
}));

const NOTIFICATION_API = new Set([
  "markNotificationsReadByTarget",
  "markNotificationRead",
  "markTaskNotificationsRead",
  "readAllNotifications",
]);

const stub = (name: string) => {
  if (NOTIFICATION_API.has(name)) {
    return async (...args: unknown[]) => {
      h.notificationCalls.push({ name, args });
      return { updated: 0 };
    };
  }
  switch (name) {
    case "channels": return async () => [h.channel];
    case "conversations": return async () => [h.conversation];
    default: return async () => [];
  }
};
const api = new Proxy({}, { get: (_t, name: string) => stub(name) });

const rtc = new Proxy({}, { get: (_t, name: string) => (name.startsWith("on") ? () => () => {} : vi.fn()) });
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, rtc, config: { kind: "web" } }) }));
vi.mock("../store/session", () => {
  const user = { id: "me", username: "me", displayName: "Me", roles: [] as string[] };
  const state = { user, status: "authed" };
  const useSession = (sel: (s: typeof state) => unknown) => sel(state);
  useSession.getState = () => state;
  return { useSession };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../lib/fileTransfer", () => ({
  useFileTransfers: () => ({ stateOf: () => undefined, decline: vi.fn(), cancel: vi.fn() }),
}));
vi.mock("../lib/MeetingSession", () => ({
  useMeetingSession: () => ({ enter: vi.fn(), session: null, active: false }),
}));
vi.mock("../lib/useCall", () => ({
  useCall: () => new Proxy({}, { get: () => vi.fn() }),
}));
vi.mock("../lib/selectedChat", () => ({
  useSelectedChat: () => ({ selectedId: h.selectedId, closeChat: vi.fn(), openChat: vi.fn() }),
}));

import { ChannelView } from "./ChannelView";
import { DMView } from "./DMView";

function mount(ui: React.ReactNode, path: string, route: string) {
  Element.prototype.scrollTo = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, ...view };
}

const names = () => h.notificationCalls.map((c) => c.name);

beforeEach(() => {
  h.notificationCalls.length = 0;
  h.selectedId = "cv-1";
});

describe("opening a chat or a channel reads its notifications", () => {
  it("opening a conversation reads that conversation's notifications, and only that", async () => {
    mount(<DMView />, "/chats/cv-1", "/chats/:conversationId");

    await waitFor(() => expect(h.notificationCalls).toHaveLength(1));
    expect(h.notificationCalls[0]).toEqual({ name: "markNotificationsReadByTarget", args: [{ conversationId: "cv-1" }] });
  });

  it("opening a channel reads that channel's notifications, and only that", async () => {
    mount(<ChannelView />, "/channels/ch-1", "/channels/:channelId");

    await waitFor(() => expect(h.notificationCalls).toHaveLength(1));
    expect(h.notificationCalls[0]).toEqual({ name: "markNotificationsReadByTarget", args: [{ channelId: "ch-1" }] });
  });

  it("never reads everything, and never touches task notifications or a single row", async () => {
    const dm = mount(<DMView />, "/chats/cv-1", "/chats/:conversationId");
    await waitFor(() => expect(h.notificationCalls).toHaveLength(1));
    dm.unmount();
    mount(<ChannelView />, "/channels/ch-1", "/channels/:channelId");
    await waitFor(() => expect(h.notificationCalls).toHaveLength(2));

    expect(names()).not.toContain("readAllNotifications");
    expect(names()).not.toContain("markTaskNotificationsRead");
    expect(names()).not.toContain("markNotificationRead");
  });

  it("asks only once however many times the open conversation re-renders", async () => {
    const { qc } = mount(<DMView />, "/chats/cv-1", "/chats/:conversationId");
    await waitFor(() => expect(h.notificationCalls).toHaveLength(1));
    await qc.invalidateQueries();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.notificationCalls).toHaveLength(1);
  });
});
