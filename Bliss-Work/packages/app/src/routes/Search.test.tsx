/**
 * The search page's "People" results.
 *
 * A person's row used to fall back to a bare `to: "/app/chats"` — a leftover
 * from before profile pages existed. SearchResults renders a row with no
 * `onSelect` as a plain NavLink, so that sent every "People" click to the
 * chat SECTION with no conversation selected. Which conversation shows is
 * tracked out of the URL entirely (lib/selectedChat), so the chat view just
 * kept displaying whatever conversation was already open — clicking a
 * person's profile result silently opened the chat window instead, showing
 * whatever chat was last open rather than that person's.
 *
 * This pins the row's destination as the person's own profile route, and
 * that it is a real link rather than a chat-selecting button.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UserDTO } from "@taskboard/shared";

const api = {
  directory: vi.fn(),
  channels: vi.fn(),
  conversations: vi.fn(),
  taskAssigned: vi.fn(),
  tasksSent: vi.fn(),
};

const ME: UserDTO = {
  id: "me-1",
  orgId: "org-1",
  orgName: "Acme",
  username: "me",
  displayName: "Me",
  email: "me@example.com",
  roles: ["member"],
  plan: "free",
  avatarUrl: null,
  mfaEnrolled: false,
  orgRequireMfaForAdmins: false,
  orgMfaGracePeriodEndsAt: null,
};

const PEER: UserDTO = {
  id: "peer-1",
  orgId: "org-1",
  orgName: "Acme",
  username: "alice",
  displayName: "Alice Ng",
  email: "alice@example.com",
  roles: ["member"],
  plan: "free",
  avatarUrl: null,
  mfaEnrolled: false,
  orgRequireMfaForAdmins: false,
  orgMfaGracePeriodEndsAt: null,
};

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: { kind: "web" } }) }));
vi.mock("../store/session", () => ({
  useSession: (select: (s: unknown) => unknown) => select({ user: ME }),
}));

import { Search } from "./Search";
import { SelectedChatProvider } from "../lib/selectedChat";

function renderSearch(query: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/app/search?q=${query}`]}>
      <QueryClientProvider client={qc}>
        <SelectedChatProvider>
          <Search />
        </SelectedChatProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.directory.mockResolvedValue([PEER]);
  api.channels.mockResolvedValue([]);
  api.conversations.mockResolvedValue([]);
  api.taskAssigned.mockResolvedValue([]);
  api.tasksSent.mockResolvedValue([]);
});

describe("People results in search", () => {
  it("links a person's row to their profile page, not the chat list", async () => {
    renderSearch("Alice");
    const link = await screen.findByRole("link", { name: /Alice Ng/ });
    expect(link).toHaveAttribute("href", "/app/members/peer-1");
  });

  it("does not render the row as a chat-selecting button", async () => {
    renderSearch("Alice");
    await screen.findByRole("link", { name: /Alice Ng/ });
    // A chat row (the separate "Chats" group) renders as a <button
    // onClick={openChat}>; a profile row must not — it's a real addressable
    // route, not an in-memory chat selection.
    expect(screen.queryByRole("button", { name: /Alice Ng/ })).toBeNull();
  });
});
