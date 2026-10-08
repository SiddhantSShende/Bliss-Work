import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { WsStatus } from "@taskboard/shared";
import { RESYNC_DELAY_MS, watchReconnectResync } from "./reconnectResync";
import { qk } from "./queryKeys";

function fakeSocketStatus() {
  const handlers = new Set<(s: WsStatus) => void>();
  return {
    onStatus: (h: (s: WsStatus) => void) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    emit: (s: WsStatus) => handlers.forEach((h) => h(s)),
    count: () => handlers.size,
  };
}

describe("watchReconnectResync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("invalidates pushed-data queries after a reconnect, not before the delay", () => {
    const sock = fakeSocketStatus();
    const qc = { invalidateQueries: vi.fn() };
    watchReconnectResync(sock, qc as never);

    sock.emit("open"); // first connect
    sock.emit("closed");
    sock.emit("connecting");
    sock.emit("open");
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RESYNC_DELAY_MS);
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("does nothing on the first connect, even after failed attempts", () => {
    const sock = fakeSocketStatus();
    const qc = { invalidateQueries: vi.fn() };
    watchReconnectResync(sock, qc as never);

    sock.emit("connecting");
    sock.emit("closed"); // first attempt failed
    sock.emit("connecting");
    sock.emit("open");
    vi.advanceTimersByTime(RESYNC_DELAY_MS * 2);
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });

  it("does not resync when the socket merely re-authenticates while open", () => {
    const sock = fakeSocketStatus();
    const qc = { invalidateQueries: vi.fn() };
    watchReconnectResync(sock, qc as never);
    sock.emit("open");
    sock.emit("reauth");
    sock.emit("open");
    vi.advanceTimersByTime(RESYNC_DELAY_MS * 2);
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });

  it("collapses a flapping connection into one resync", () => {
    const sock = fakeSocketStatus();
    const qc = { invalidateQueries: vi.fn() };
    watchReconnectResync(sock, qc as never);
    sock.emit("open");
    for (let i = 0; i < 4; i++) {
      sock.emit("closed");
      sock.emit("open");
      vi.advanceTimersByTime(RESYNC_DELAY_MS / 4);
    }
    vi.advanceTimersByTime(RESYNC_DELAY_MS);
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending resync and unsubscribes on teardown", () => {
    const sock = fakeSocketStatus();
    const qc = { invalidateQueries: vi.fn() };
    const stop = watchReconnectResync(sock, qc as never);
    sock.emit("open");
    sock.emit("closed");
    sock.emit("open");
    stop();
    vi.advanceTimersByTime(RESYNC_DELAY_MS * 2);
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
    expect(sock.count()).toBe(0);
  });

  it("selects pushed roots only, leaving a composer's draft and static maps alone", () => {
    const sock = fakeSocketStatus();
    const invalidateQueries = vi.fn();
    watchReconnectResync(sock, { invalidateQueries } as never);
    sock.emit("open");
    sock.emit("closed");
    sock.emit("open");
    vi.advanceTimersByTime(RESYNC_DELAY_MS);

    const { predicate } = invalidateQueries.mock.calls[0]![0] as {
      predicate: (q: { queryKey: readonly unknown[] }) => boolean;
    };
    for (const key of [
      qk.conversations,
      qk.messages("c1"),
      qk.channelMessages("ch1"),
      qk.inbox,
      qk.unifiedInbox,
      qk.call("x"),
      qk.notificationsUnreadCount,
      qk.unreadCounts,
    ]) {
      expect(predicate({ queryKey: key })).toBe(true);
    }
    for (const key of [qk.mail("draft"), ["staticMap", "1,2,3"], qk.directory, qk.myOrgs]) {
      expect(predicate({ queryKey: key })).toBe(false);
    }
  });

  it("refetches only ACTIVE matching queries in a real QueryClient", async () => {
    vi.useRealTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } });
    const fetches = { messages: 0, mail: 0, inactiveChannels: 0 };
    const observe = (key: readonly unknown[], counter: keyof typeof fetches) => {
      const o = new QueryObserver(qc, {
        queryKey: key,
        queryFn: async () => ++fetches[counter],
      });
      return o.subscribe(() => {});
    };
    const unsubs = [observe(qk.messages("c1"), "messages"), observe(qk.mail("d1"), "mail")];
    // Seeded and then left with no observer: matches, but is inactive.
    await qc.prefetchQuery({ queryKey: qk.channels, queryFn: async () => ++fetches.inactiveChannels });
    await vi.waitFor(() => expect(fetches.messages).toBe(1));

    const sock = fakeSocketStatus();
    watchReconnectResync(sock, qc, 5);
    sock.emit("open");
    sock.emit("closed");
    sock.emit("open");

    await vi.waitFor(() => expect(fetches.messages).toBe(2));
    expect(fetches.mail).toBe(1);
    expect(fetches.inactiveChannels).toBe(1);
    expect(qc.getQueryState(qk.channels)?.isInvalidated).toBe(true);
    unsubs.forEach((u) => u());
  });
});
