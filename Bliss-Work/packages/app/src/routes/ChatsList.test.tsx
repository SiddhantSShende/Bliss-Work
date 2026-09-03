/**
 * The sidebar's last-message preview after "Clear Chat".
 *
 * ListConversations now reports `cleared: true` once the caller has hidden
 * every message in a conversation that genuinely has history (see
 * services/messaging-svc/internal/store/conversations.go). This pins the
 * client side of that fix: a cleared row keeps its name but renders NO
 * preview text at all — not the old message, not "Start chatting". A
 * conversation that was never cleared, and one that has simply never had a
 * message, must keep their existing (different) behaviors.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConversationDTO } from "@taskboard/shared";

const api = {
  conversations: vi.fn(),
  presenceOf: vi.fn(),
};

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: { kind: "web" } }) }));
vi.mock("../store/session", () => ({
  useSession: (select: (s: unknown) => unknown) => select({ user: { id: "me-1" } }),
}));

import { ChatsList } from "./ChatsList";
import { SelectedChatProvider } from "../lib/selectedChat";

function baseConv(overrides: Partial<ConversationDTO>): ConversationDTO {
  return {
    id: "conv-base",
    peerId: "peer-base",
    peerUsername: "peer",
    peerDisplayName: "Peer",
    lastMessage: null,
    lastMessageAt: null,
    lastMessageSender: "",
    lastMessageSenderId: "",
    cleared: false,
    unread: 0,
    blockedByMe: false,
    blockedByPeer: false,
    ...overrides,
  };
}

function renderChatsList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/app/chats"]}>
      <QueryClientProvider client={qc}>
        <SelectedChatProvider>
          <ChatsList />
        </SelectedChatProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.presenceOf.mockResolvedValue([]);
});

describe("ChatsList last-message preview", () => {
  it("renders no preview text at all for a cleared chat — not the old message, not a placeholder", async () => {
    api.conversations.mockResolvedValue([
      baseConv({
        id: "conv-cleared",
        peerId: "peer-cleared",
        peerDisplayName: "Cleared Peer",
        lastMessage: null,
        cleared: true,
      }),
    ]);
    renderChatsList();

    await screen.findByText("Cleared Peer");
    expect(screen.queryByText("Start chatting")).not.toBeInTheDocument();
    expect(screen.queryByText(/No messages yet/i)).not.toBeInTheDocument();
  });

  it("keeps showing the real last message for a chat that was never cleared", async () => {
    api.conversations.mockResolvedValue([
      baseConv({
        id: "conv-fresh",
        peerId: "peer-fresh",
        peerDisplayName: "Fresh Peer",
        lastMessage: "quarterly numbers are in",
        cleared: false,
      }),
    ]);
    renderChatsList();

    await screen.findByText("Fresh Peer");
    expect(await screen.findByText("quarterly numbers are in")).toBeInTheDocument();
  });

  it("prefixes the preview with \"You: \" when the caller sent the last message", async () => {
    api.conversations.mockResolvedValue([
      baseConv({
        id: "conv-own",
        peerId: "peer-own",
        peerDisplayName: "Own Peer",
        lastMessage: "Hello, how are you?",
        lastMessageSenderId: "me-1",
        cleared: false,
      }),
    ]);
    renderChatsList();

    await screen.findByText("Own Peer");
    expect(await screen.findByText("You: Hello, how are you?")).toBeInTheDocument();
  });

  it("leaves the peer's own message unprefixed, same as before", async () => {
    api.conversations.mockResolvedValue([
      baseConv({
        id: "conv-peer",
        peerId: "peer-theirs",
        peerDisplayName: "Their Peer",
        lastMessage: "on my way",
        lastMessageSenderId: "peer-theirs",
        cleared: false,
      }),
    ]);
    renderChatsList();

    await screen.findByText("Their Peer");
    expect(await screen.findByText("on my way")).toBeInTheDocument();
    expect(screen.queryByText(/^You:/)).not.toBeInTheDocument();
  });

  it("still shows the 'Start chatting' placeholder for a chat that has never had a message", async () => {
    api.conversations.mockResolvedValue([
      baseConv({
        id: "conv-empty",
        peerId: "peer-empty",
        peerDisplayName: "Empty Peer",
        lastMessage: null,
        cleared: false,
      }),
    ]);
    renderChatsList();

    await screen.findByText("Empty Peer");
    expect(await screen.findByText("Start chatting")).toBeInTheDocument();
  });
});
