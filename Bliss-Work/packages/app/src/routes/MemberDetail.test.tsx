/**
 * Regression coverage: the route at `members/:userId` has no `key`, so
 * navigating between members reuses the SAME MemberDetail instance rather
 * than remounting it. The `useEffect` keyed on `[userId]` reset `tab` and
 * `exportOpen` on every member change but left `patched` (the locally-cached
 * mutation result from an admin action, e.g. a role change) alone, guarded
 * only by `patched?.id === userId`. Navigating A -> B -> back to A re-satisfies
 * that guard, so the STALE patched snapshot from the earlier visit would
 * outlive the navigation and be shown instead of the freshly-refetched roster
 * — even if someone else changed A again in the meantime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MemberDTO } from "@taskboard/shared";
import { SelectedChatProvider } from "../lib/selectedChat";

const api = {
  listMembers: vi.fn(),
  directory: vi.fn(),
  memberActivity: vi.fn(),
  conversations: vi.fn(),
  changeMemberRole: vi.fn(),
};

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: unknown) => unknown) =>
    sel({ user: { id: "me-admin", roles: ["org_admin"] } }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MemberDetail } from "./MemberDetail";

function member(over: Partial<MemberDTO>): MemberDTO {
  return {
    id: "u-default",
    username: "default",
    displayName: "Default",
    email: "default@acme.com",
    roles: ["member"],
    status: "active",
    emailVerified: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    removedAt: null,
    avatarUrl: null,
    ...over,
  };
}

/** Stand-in for the app shell's member links — navigates within the SAME
 *  router without remounting <MemberDetail>, exactly like clicking between
 *  two rows in the real member list. */
function NavButtons() {
  const nav = useNavigate();
  return (
    <div>
      <button onClick={() => nav("/app/members/u1")}>go-u1</button>
      <button onClick={() => nav("/app/members/u2")}>go-u2</button>
    </div>
  );
}

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/app/members/u1"]}>
        <SelectedChatProvider>
          <NavButtons />
          <Routes>
            <Route path="/app/members/:userId" element={<MemberDetail />} />
          </Routes>
        </SelectedChatProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MemberDetail: patched state must not survive a round-trip navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.directory.mockResolvedValue([]);
    api.memberActivity.mockResolvedValue([]);
    api.conversations.mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows the freshly-refetched roster for A, not the earlier local patch, after A -> B -> A", async () => {
    const aliceOriginal = member({ id: "u1", username: "alice", displayName: "Alice", roles: ["member"] });
    const bob = member({ id: "u2", username: "bob", displayName: "Bob" });
    // What the mutation itself returns and MemberDetail caches as `patched`
    // for instant feedback — same name, promoted role.
    const alicePatchedByMutation = member({
      id: "u1", username: "alice", displayName: "Alice", roles: ["org_admin"],
    });
    // What the roster actually holds once the invalidation-triggered refetch
    // lands — standing in for a further, independent change (e.g. by another
    // admin) that arrived after the mutation's own response. This is the data
    // a correct implementation must show after the round trip.
    const aliceAfterConcurrentChange = member({
      id: "u1", username: "alice", displayName: "Alice Renamed By Someone Else", roles: ["member"],
    });

    api.listMembers
      .mockResolvedValueOnce([aliceOriginal, bob])
      .mockResolvedValueOnce([aliceAfterConcurrentChange, bob]);
    api.changeMemberRole.mockResolvedValue(alicePatchedByMutation);

    renderDetail();
    expect(await screen.findByText("Alice")).toBeTruthy();

    // Apply a local patch exactly as MemberAdmin does for real: this sets
    // `patched` (via onChanged) AND invalidates the members query.
    screen.getByRole("tab", { name: "Admin" }).click();
    (await screen.findByRole("button", { name: /Make admin/i })).click();

    // The invalidation-triggered refetch (api.listMembers call #2) must land
    // before we navigate, so the roster cache genuinely holds the "concurrent
    // change" by the time we come back to it.
    await waitFor(() => expect(api.listMembers).toHaveBeenCalledTimes(2));

    // Still on A: `patched` wins over the (now-updated) roster cache — this is
    // the existing, correct "instant feedback" behavior and not what this
    // test is regression-checking.
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.queryByText("Alice Renamed By Someone Else")).toBeNull();

    // Navigate away, then back — the same MemberDetail instance is reused.
    screen.getByRole("button", { name: "go-u2" }).click();
    expect(await screen.findByText("Bob")).toBeTruthy();
    screen.getByRole("button", { name: "go-u1" }).click();

    // The stale patched snapshot ("Alice", promoted to admin) must not
    // survive the round trip. The freshly-refetched roster row must win.
    expect(await screen.findByText("Alice Renamed By Someone Else")).toBeTruthy();
    expect(screen.queryByText("Alice", { exact: true })).toBeNull();
  });
});
