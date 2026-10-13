/**
 * Notes to Self in the chat list: a permanent, pinned entry (not a row
 * derived from `conversations`, so it is discoverable even before it has
 * ever been opened — see store.OpenSelfChat), clicking it opens/creates it
 * via the dedicated endpoint, and the underlying conversation row (once it
 * exists) never ALSO appears as an ordinary peer row.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConversationDTO } from "@taskboard/shared";

const ME = "me-id";
const PEER = "peer-id";

const h = vi.hoisted(() => ({ api: {} as Record<string, (...args: never[]) => Promise<unknown>> }));
const openChat = vi.fn();
const openSelfChatSpy = vi.fn();

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: { user: { id: string; username: string; displayName: string } }) => unknown) =>
    sel({ user: { id: ME, username: "me", displayName: "Me" } }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../lib/selectedChat", () => ({
  CHATS_PATH: "/app/chats",
  useSelectedChat: () => ({ selectedId: null, openChat, closeChat: vi.fn() }),
}));
vi.mock("../lib/usePresence", () => ({ usePresence: () => new Set<string>() }));
vi.mock("../lib/userLabel", async (orig) => ({
  ...(await orig<typeof import("../lib/userLabel")>()),
  useUserLabels: () => ({ avatarUrlOf: () => undefined }),
}));

import { ChatsList } from "./ChatsList";

function renderList(conversations: ConversationDTO[]) {
  h.api = {
    conversations: async () => conversations,
    openSelfChat: async () => {
      openSelfChatSpy();
      return { conversationId: "self-conv-1" };
    },
  };
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/app/chats"]}>
        <ChatsList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Notes to Self in the chat list", () => {
  it("renders the pinned row before it has ever been opened, and opens/creates it on click", async () => {
    renderList([]);
    const row = await screen.findByText("Notes to Self");
    expect(screen.getByText("Your personal space")).toBeTruthy();

    await userEvent.click(row);
    await waitFor(() => expect(openSelfChatSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(openChat).toHaveBeenCalledWith("self-conv-1"));
  });

  it("never renders the underlying self-chat conversation row a second time", async () => {
    const selfConv = {
      id: "self-conv-1",
      peerId: ME,
      peerUsername: "me",
      peerDisplayName: "Me",
      lastMessage: "pick up milk",
      lastMessageAt: "2026-10-01T09:00:00Z",
      lastMessageSenderId: ME,
      unread: 0,
      cleared: false,
    } as unknown as ConversationDTO;
    const peerConv = {
      id: "c2",
      peerId: PEER,
      peerUsername: "ada",
      peerDisplayName: "Ada Lovelace",
      lastMessage: "hey",
      lastMessageAt: "2026-10-01T09:05:00Z",
      lastMessageSenderId: PEER,
      unread: 0,
      cleared: false,
    } as unknown as ConversationDTO;

    renderList([selfConv, peerConv]);
    await screen.findByText("Ada Lovelace");
    // Exactly one "Notes to Self" row — the pinned fixture — never a second
    // one rendered from the ordinary `conversations` list, and its preview
    // shows the real last message once the row exists.
    expect(screen.getAllByText("Notes to Self")).toHaveLength(1);
    expect(screen.getByText("pick up milk")).toBeTruthy();
    expect(screen.queryByText("Your personal space")).toBeNull();
  });
});
