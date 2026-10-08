/**
 * A chat whose last message is an attachment carries its envelope JSON after
 * a readable prefix. The chat list shows a short preview of it ("Image sent");
 * Search and the chat list's own filter used to show / match the raw body, so
 * the JSON was visible in Search results and matched by typing a fragment of it.
 */
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConversationDTO } from "@taskboard/shared";
import { encodeMedia } from "../lib/chatEnvelope";

const ME = "me-id";
const PEER = "peer-id";

const media = encodeMedia([{ id: "att-9f3c", name: "holiday.png", size: 2048, mime: "image/png" }]);
const conversation = {
  id: "c1",
  peerId: PEER,
  peerUsername: "ada",
  peerDisplayName: "Ada Lovelace",
  lastMessage: media,
  lastMessageAt: "2026-10-01T09:00:00Z",
  lastMessageSender: "Ada Lovelace",
  lastMessageSenderId: PEER,
  unread: 0,
  cleared: false,
} as unknown as ConversationDTO;

const h = vi.hoisted(() => ({ api: {} as Record<string, () => Promise<unknown>> }));
const conversationsFetched = vi.fn();
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: { user: { id: string; username: string; displayName: string } }) => unknown) =>
    sel({ user: { id: ME, username: "me", displayName: "Me" } }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../lib/selectedChat", () => ({
  CHATS_PATH: "/app/chats",
  useSelectedChat: () => ({ selectedId: null, openChat: vi.fn(), closeChat: vi.fn() }),
}));
vi.mock("../lib/usePresence", () => ({ usePresence: () => new Set<string>() }));
vi.mock("../lib/userLabel", async (orig) => ({
  ...(await orig<typeof import("../lib/userLabel")>()),
  useUserLabels: () => ({ avatarUrlOf: () => undefined }),
}));

import { Search } from "./Search";
import { ChatsList } from "./ChatsList";

function renderAt(ui: React.ReactElement, url: string) {
  h.api = {
    directory: async () => [],
    channels: async () => [],
    conversations: async () => {
      conversationsFetched();
      return [conversation];
    },
    taskAssigned: async () => [],
    tasksSent: async () => [],
  };
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Search results for a chat whose last message is an attachment", () => {
  it("shows the short preview, never the envelope JSON", async () => {
    const { container } = renderAt(<Search />, "/app/search?q=ada");
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(container.textContent).not.toContain("att-9f3c");
    expect(container.textContent).not.toContain("{");
    expect(container.textContent).toContain("Image sent");
  });

  it("does not match a fragment of the envelope JSON", async () => {
    renderAt(<Search />, "/app/search?q=att-9f3c");
    // "No matches" is also what shows BEFORE the queries load, so let them land.
    await waitFor(() => expect(conversationsFetched).toHaveBeenCalled());
    await act(() => new Promise<void>((r) => setTimeout(r, 50)));
    expect(screen.getByText("No matches")).toBeTruthy();
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
  });

  it("still finds the chat by the attachment's file name (the readable prefix)", async () => {
    renderAt(<Search />, "/app/search?q=holiday");
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
  });
});

describe("ChatsList filter", () => {
  it("does not match a fragment of the envelope JSON, but does match the file name", async () => {
    const { container, unmount } = renderAt(<ChatsList />, "/app/chats");
    await screen.findByText("Ada Lovelace");
    const box = container.querySelector("input")!;
    await userEvent.type(box, "att-9f3c");
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
    await userEvent.clear(box);
    await userEvent.type(box, "holiday");
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    unmount();
  });
});
