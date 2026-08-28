/**
 * The sidebar's last-message preview after "Clear Chat" on a channel.
 *
 * ListChannels now reports `cleared: true` once the caller has hidden every
 * message in a channel that genuinely has history (see
 * services/messaging-svc/internal/store/channels_read.go). This pins the
 * client side of that fix: a cleared row keeps its name but renders NO
 * preview text at all — not the old message, not the member-count
 * placeholder. A channel that was never cleared, and one that has simply
 * never had a message, must keep their existing (different) behaviors.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelDTO } from "@taskboard/shared";

const api = {
  channels: vi.fn(),
  openChannels: vi.fn(),
};

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: { kind: "web" } }) }));
vi.mock("../store/session", () => ({
  useSession: (select: (s: unknown) => unknown) => select({ user: { id: "me-1" } }),
}));

import { ChannelsList } from "./ChannelsList";

function baseChannel(overrides: Partial<ChannelDTO>): ChannelDTO {
  return {
    id: "chan-base",
    name: "chan-base",
    memberCount: 5,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageSenderId: "",
    cleared: false,
    unread: 0,
    isLocked: false,
    iAmMember: true,
    createdBy: "",
    myRole: "member",
    ...overrides,
  };
}

function renderChannelsList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/app/channels"]}>
      <QueryClientProvider client={qc}>
        <ChannelsList />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.openChannels.mockResolvedValue([]);
});

describe("ChannelsList last-message preview", () => {
  it("renders no preview text at all for a cleared channel — not the old message, not the member count", async () => {
    api.channels.mockResolvedValue([
      baseChannel({ id: "chan-cleared", name: "cleared-channel", lastMessage: null, cleared: true, memberCount: 12 }),
    ]);
    renderChannelsList();

    await screen.findByText("cleared-channel");
    expect(screen.queryByText("12 members")).not.toBeInTheDocument();
    expect(screen.queryByText(/No messages yet/i)).not.toBeInTheDocument();
  });

  it("keeps showing the real last message for a channel that was never cleared", async () => {
    api.channels.mockResolvedValue([
      baseChannel({
        id: "chan-fresh",
        name: "fresh-channel",
        lastMessage: "quarterly numbers are in",
        cleared: false,
      }),
    ]);
    renderChannelsList();

    await screen.findByText("fresh-channel");
    expect(await screen.findByText("quarterly numbers are in")).toBeInTheDocument();
  });

  it("still shows the member-count placeholder for a channel that has never had a message", async () => {
    api.channels.mockResolvedValue([
      baseChannel({ id: "chan-empty", name: "empty-channel", lastMessage: null, cleared: false, memberCount: 3 }),
    ]);
    renderChannelsList();

    await screen.findByText("empty-channel");
    expect(await screen.findByText("3 members")).toBeInTheDocument();
  });
});
