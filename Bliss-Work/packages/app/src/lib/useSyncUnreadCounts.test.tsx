/**
 * The rail badges are summed by their own endpoint, so a local read that only
 * touched the list behind them (an invalidation, or a setQueryData patch) left
 * the badge stale. The hook ties the two together.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { qk } from "./queryKeys";
import { useSyncUnreadCounts } from "./useSyncUnreadCounts";

let qc: QueryClient;
let invalidate: MockInstance<QueryClient["invalidateQueries"]>;

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);
const badgeRefreshes = () =>
  invalidate.mock.calls.filter(([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(qk.unreadCounts));

beforeEach(() => {
  vi.useFakeTimers();
  qc = new QueryClient();
  invalidate = vi.spyOn(qc, "invalidateQueries");
});
afterEach(() => vi.useRealTimers());

describe("useSyncUnreadCounts", () => {
  it.each([
    ["conversations", qk.conversations],
    ["channels", qk.channels],
    ["inboxPeers", qk.inboxPeers],
  ])("refreshes the badges when the %s list is patched locally", (_name, key) => {
    renderHook(() => useSyncUnreadCounts(), { wrapper });

    qc.setQueryData(key, []);
    vi.advanceTimersByTime(200);

    expect(badgeRefreshes()).toHaveLength(1);
  });

  it("refreshes the badges when a counted list is invalidated", () => {
    qc.setQueryData(qk.conversations, []);
    renderHook(() => useSyncUnreadCounts(), { wrapper });
    invalidate.mockClear();

    void qc.invalidateQueries({ queryKey: qk.conversations });
    vi.advanceTimersByTime(200);

    expect(badgeRefreshes()).toHaveLength(1);
  });

  it("does one refresh for the burst a single action produces", () => {
    renderHook(() => useSyncUnreadCounts(), { wrapper });

    qc.setQueryData(qk.conversations, []);
    qc.setQueryData(qk.channels, []);
    qc.setQueryData(qk.inboxPeers, []);
    vi.advanceTimersByTime(200);

    expect(badgeRefreshes()).toHaveLength(1);
  });

  it("ignores queries that do not feed the totals", () => {
    renderHook(() => useSyncUnreadCounts(), { wrapper });

    qc.setQueryData(qk.inboxPeerFeed("peer-1"), []);
    qc.setQueryData(qk.openChannels, []);
    qc.setQueryData(qk.unreadCounts, { conversations: 0, channels: 0, inboxPeers: 0 });
    vi.advanceTimersByTime(200);

    expect(badgeRefreshes()).toHaveLength(0);
  });

  it("stops watching, and drops a pending refresh, when unmounted", () => {
    const { unmount } = renderHook(() => useSyncUnreadCounts(), { wrapper });
    qc.setQueryData(qk.conversations, []);

    unmount();
    vi.advanceTimersByTime(200);
    qc.setQueryData(qk.channels, []);
    vi.advanceTimersByTime(200);

    expect(badgeRefreshes()).toHaveLength(0);
  });
});
