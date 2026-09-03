/**
 * Regression coverage for a thread that goes unread again never being
 * re-reported as read to the server.
 *
 * THREAD's `refId` is the thread id and never changes for the life of the
 * thread (see InboxItemDTO in packages/shared/src/types/domain.ts), and
 * inboxPatch.ts's patchInboxOnMessage bumps that SAME row's `unreadCount` and
 * `lastEventAt` when a reply arrives. A dedupe keyed on refId membership alone
 * would therefore permanently block a thread that goes
 * unread -> read -> unread again from ever calling api.readThread a second
 * time, even though the optimistic patch keeps making the UI look read. The
 * fix keys the "already marked" check on (refId, lastEventAt) instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApiClient, InboxItemDTO } from "@taskboard/shared";
import { useMarkPeerRead } from "./useMarkPeerRead";

const PEER_A = "018f0000-0000-7000-8000-0000000000a1";
const PEER_B = "018f0000-0000-7000-8000-0000000000b2";
const THREAD_ID = "018f0000-0000-7000-8000-0000000000c3";

const api = {
  readThread: vi.fn(async () => {}),
  readInboxItem: vi.fn(async () => {}),
} as unknown as ApiClient;

function threadItem(over: Partial<InboxItemDTO> = {}): InboxItemDTO {
  return {
    ownerUserId: "018f0000-0000-7000-8000-0000000000ff",
    itemKind: "THREAD",
    refId: THREAD_ID,
    peerUserId: PEER_A,
    peerUsername: "jane",
    preview: "hey",
    lastEventAt: "2026-08-01T09:00:00.000Z",
    unreadCount: 1,
    statusBadge: null,
    hiddenForOwner: false,
    deletedForOwner: false,
    ...over,
  };
}

function renderMarkPeerRead(peerId: string | undefined, items: InboxItemDTO[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderHook(
    ({ peerId, items }: { peerId: string | undefined; items: InboxItemDTO[] }) =>
      useMarkPeerRead(api, peerId, items),
    {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
      initialProps: { peerId, items },
    },
  );
  return { qc, ...view };
}

beforeEach(() => {
  vi.mocked(api.readThread).mockClear();
  vi.mocked(api.readInboxItem).mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useMarkPeerRead", () => {
  it("marks an unread thread read on open", async () => {
    renderMarkPeerRead(PEER_A, [threadItem()]);

    await waitFor(() =>
      expect(api.readThread).toHaveBeenCalledWith(THREAD_ID, Number.MAX_SAFE_INTEGER),
    );
  });

  it("does not re-mark the same still-unread thread on a no-op reopen", async () => {
    const { rerender } = renderMarkPeerRead(PEER_A, [threadItem()]);
    await waitFor(() => expect(api.readThread).toHaveBeenCalledTimes(1));

    // Leave and come back to the same peer; the thread's server state hasn't
    // moved at all (same lastEventAt) — this must not refire the request.
    rerender({ peerId: PEER_B, items: [] });
    rerender({ peerId: PEER_A, items: [threadItem()] });

    await Promise.resolve();
    expect(api.readThread).toHaveBeenCalledTimes(1);
  });

  it("re-marks a thread that goes unread again after a later reply", async () => {
    const { rerender } = renderMarkPeerRead(PEER_A, [threadItem()]);
    await waitFor(() => expect(api.readThread).toHaveBeenCalledTimes(1));

    // A reply arrives after the thread was marked read: the SAME threadId
    // (refId never changes), but unreadCount and lastEventAt both move —
    // exactly what inboxPatch.ts's patchInboxOnMessage does on a new message.
    rerender({ peerId: PEER_B, items: [] });
    rerender({
      peerId: PEER_A,
      items: [threadItem({ unreadCount: 1, lastEventAt: "2026-08-01T09:05:00.000Z" })],
    });

    await waitFor(() => expect(api.readThread).toHaveBeenCalledTimes(2));
    expect(api.readThread).toHaveBeenNthCalledWith(2, THREAD_ID, Number.MAX_SAFE_INTEGER);
  });

  it("never touches a thread belonging to a different peer", async () => {
    renderMarkPeerRead(PEER_A, [threadItem({ peerUserId: PEER_B })]);

    await Promise.resolve();
    expect(api.readThread).not.toHaveBeenCalled();
  });
});
