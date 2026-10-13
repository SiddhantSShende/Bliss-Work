/**
 * Notes to Self inside the conversation view itself: same ConversationDTO
 * shape as any other 1:1 (the peer IS the caller — see store.OpenSelfChat),
 * so DMView has to tell the difference and render accordingly — a dedicated
 * identity/subtitle, no Block or Call (neither means anything pointed at
 * yourself), and a self-specific composer placeholder. Mounts the real
 * DMView, following the same minimal mocking shape as
 * chatActivityTimeline.test.tsx, which already proves this shell works.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  conversation: { id: "cv-1", peerId: "me", peerUsername: "me", peerDisplayName: "Me" } as unknown,
  messages: [] as unknown[],
}));

const stub = (name: string) => {
  switch (name) {
    case "conversations": return async () => [h.conversation];
    case "messages": return async () => h.messages;
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
vi.mock("../lib/useCall", () => ({ useCall: () => new Proxy({}, { get: () => vi.fn() }) }));
vi.mock("../lib/selectedChat", () => ({
  useSelectedChat: () => ({ selectedId: "cv-1", closeChat: vi.fn(), openChat: vi.fn() }),
}));

import { DMView } from "./DMView";

function mount() {
  Element.prototype.scrollTo = vi.fn();
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/chats/cv-1"]}>
        <Routes>
          <Route path="/chats/:conversationId" element={<DMView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("DMView: Notes to Self", () => {
  it("shows the self identity and subtitle, a self composer placeholder, and no Block/Call controls", async () => {
    mount();

    expect(await screen.findByText("Notes to Self")).toBeTruthy();
    expect(screen.getByText("Your personal space")).toBeTruthy();
    expect(screen.getByPlaceholderText("Write a note to yourself…")).toBeTruthy();

    // Block/unblock and the call menu all assume a second person.
    expect(screen.queryByText("Block")).toBeNull();
    expect(screen.queryByText("Unblock")).toBeNull();
    expect(screen.queryByTitle("Voice call")).toBeNull();
  });
});
