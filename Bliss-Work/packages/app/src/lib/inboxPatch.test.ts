/**
 * Tests for the pure TanStack cache-patch helpers (inboxPatch.ts).
 *
 * These run inside WsEventBridge on every inbound WS event and decide what the
 * open Inbox / Thread screens show WITHOUT a refetch. The load-bearing bits are
 * the unread-count math, the SENT-vs-incoming badge choice, thread hoisting,
 * dedup on append, and the status-bump scoping (only the sender's own bubbles,
 * only up to upToSeq). We drive a REAL QueryClient (no React) and assert on the
 * data it holds after each patch — exactly how the bridge calls these.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type {
  InboxItemDTO,
  InboxPageDTO,
  MessageDTO,
  MessageCreated,
  MessageDelivered,
  MessageRead,
  MessageDismissed,
  ConversationIgnored,
} from "@taskboard/shared";
import { qk } from "./queryBridge";
import {
  patchInboxOnMessage,
  patchThreadOnMessage,
  patchInboxOnIgnored,
  patchThreadOnDelivered,
  patchThreadOnRead,
  patchOnDismissed,
} from "./inboxPatch";

const ME = "me-00000000-0000-0000-0000-000000000001";
const PEER = "peer-0000-0000-0000-0000-000000000002";
const THREAD = "thread-00-0000-0000-0000-000000000003";

type InboxInfinite = { pages: InboxPageDTO[]; pageParams: (string | undefined)[] };
type ThreadInfinite = { pages: MessageDTO[][]; pageParams: (number | undefined)[] };

function inboxItem(over: Partial<InboxItemDTO> = {}): InboxItemDTO {
  return {
    ownerUserId: ME,
    itemKind: "THREAD",
    refId: THREAD,
    peerUserId: PEER,
    peerUsername: "peer",
    preview: "old preview",
    lastEventAt: "2026-06-24T10:00:00.000Z",
    unreadCount: 0,
    statusBadge: null,
    hiddenForOwner: false,
    deletedForOwner: false,
    ...over,
  };
}

function seedInbox(qc: QueryClient, items: InboxItemDTO[]): void {
  const data: InboxInfinite = {
    pages: [{ items, nextCursor: null }],
    pageParams: [undefined],
  };
  qc.setQueryData(qk.unifiedInbox, data);
}

function seedThread(qc: QueryClient, threadId: string, pages: MessageDTO[][]): void {
  const data: ThreadInfinite = {
    pages,
    pageParams: pages.map(() => undefined),
  };
  qc.setQueryData(qk.threadMessages(threadId), data);
}

/** Read page-0 inbox rows back out of the cache (asserting presence — the
 *  project compiles with noUncheckedIndexedAccess, so indexed reads are T|undef). */
function inboxRows(qc: QueryClient): InboxItemDTO[] {
  const data = qc.getQueryData<InboxInfinite>(qk.unifiedInbox);
  expect(data).toBeDefined();
  const page0 = data!.pages[0];
  expect(page0).toBeDefined();
  return page0!.items;
}

/** Read page-0 of a thread's message cache. */
function threadPage0(qc: QueryClient, threadId: string): MessageDTO[] {
  const data = qc.getQueryData<ThreadInfinite>(qk.threadMessages(threadId));
  expect(data).toBeDefined();
  const page0 = data!.pages[0];
  expect(page0).toBeDefined();
  return page0!;
}

function dto(over: Partial<MessageDTO>): MessageDTO {
  // Tests only read id/seq/senderId/status; cast to keep fixtures terse, same
  // pattern as useCursorPagination.test.ts.
  return over as MessageDTO;
}

function created(over: Partial<MessageCreated> = {}): MessageCreated {
  return {
    threadId: THREAD,
    conversationId: THREAD,
    senderId: PEER,
    recipientId: ME,
    messageId: "msg-1",
    seq: 5,
    body: "hello world",
    occurredAt: "2026-06-24T12:00:00.000Z",
    // Inbox rows exist for MAIL threads only, so the inbox-patch cases below
    // are all mail. `chat` is covered separately.
    origin: "mail",
    ...over,
  } as unknown as MessageCreated;
}

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient();
});

describe("patchInboxOnMessage", () => {
  // THE separation that keeps chat out of the Inbox. The server stopped writing
  // inbox_items rows for chat threads in migration 0014; if this optimistic
  // patch still ran, chat messages would flash into the Inbox and then vanish
  // on the next refetch — the same bug, now with a flicker.
  it("ignores a CHAT message entirely", () => {
    seedInbox(qc, [inboxItem({ unreadCount: 2, statusBadge: "SEEN" })]);

    patchInboxOnMessage(qc, created({ origin: "chat", body: "a chat message" }), ME);

    const row = inboxRows(qc)[0]!;
    expect(row.unreadCount).toBe(2);
    expect(row.preview).not.toBe("a chat message");
  });

  it("ignores a message from a producer too old to say", () => {
    // Pre-0014 producers omit `origin`, and every thread they created is chat.
    seedInbox(qc, [inboxItem({ unreadCount: 2 })]);

    patchInboxOnMessage(qc, created({ origin: undefined, body: "legacy" }), ME);

    expect(inboxRows(qc)[0]!.unreadCount).toBe(2);
  });

  it("increments unreadCount for an INCOMING message and keeps the existing badge", () => {
    seedInbox(qc, [inboxItem({ unreadCount: 2, statusBadge: "SEEN" })]);

    patchInboxOnMessage(qc, created({ senderId: PEER, body: "incoming" }), ME);

    const row = inboxRows(qc)[0]!;
    expect(row.refId).toBe(THREAD);
    expect(row.unreadCount).toBe(3); // 2 + 1
    expect(row.statusBadge).toBe("SEEN"); // incoming keeps existing badge
    expect(row.preview).toBe("incoming");
    expect(row.lastEventAt).toBe("2026-06-24T12:00:00.000Z");
  });

  it("does NOT bump unreadCount for a message I sent, and stamps the SENT badge", () => {
    seedInbox(qc, [inboxItem({ unreadCount: 4, statusBadge: "SEEN" })]);

    patchInboxOnMessage(qc, created({ senderId: ME, recipientId: PEER }), ME);

    const row = inboxRows(qc)[0]!;
    expect(row.unreadCount).toBe(4); // unchanged — it's my own message
    expect(row.statusBadge).toBe("SENT");
  });

  it("hoists the thread row to the TOP of page 1", () => {
    const other = inboxItem({ refId: "other-00-0000-0000-0000-000000000099", preview: "other" });
    seedInbox(qc, [other, inboxItem({ unreadCount: 0 })]);

    patchInboxOnMessage(qc, created({ body: "bump me up" }), ME);

    const items = inboxRows(qc);
    expect(items[0]!.refId).toBe(THREAD); // moved to front
    expect(items[0]!.preview).toBe("bump me up");
    expect(items).toHaveLength(2); // page length preserved (worst row dropped)
  });

  it("truncates the preview to 80 chars", () => {
    seedInbox(qc, [inboxItem()]);
    const long = "x".repeat(200);

    patchInboxOnMessage(qc, created({ body: long }), ME);

    expect(inboxRows(qc)[0]!.preview).toHaveLength(80);
  });

  it("is a no-op when the inbox cache is empty (nothing seeded)", () => {
    expect(() => patchInboxOnMessage(qc, created(), ME)).not.toThrow();
    expect(qc.getQueryData(qk.unifiedInbox)).toBeUndefined();
  });
});

describe("patchThreadOnMessage", () => {
  it("appends a new message to page-0 in seq order", () => {
    seedThread(qc, THREAD, [[dto({ id: "a", seq: 1 }), dto({ id: "b", seq: 2 })]]);

    patchThreadOnMessage(qc, created({ messageId: "c", seq: 3, body: "new" }));

    const page0 = threadPage0(qc, THREAD);
    expect(page0.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(page0[2]!.body).toBe("new");
  });

  it("dedups: re-delivering the same messageId does not duplicate the bubble", () => {
    seedThread(qc, THREAD, [[dto({ id: "dup", seq: 1 })]]);

    patchThreadOnMessage(qc, created({ messageId: "dup", seq: 1 }));

    expect(threadPage0(qc, THREAD)).toHaveLength(1);
  });

  it("falls back to conversationId when threadId is absent", () => {
    const conv = "conv-0000-0000-0000-0000-000000000aaa";
    seedThread(qc, conv, [[dto({ id: "x", seq: 1 })]]);

    patchThreadOnMessage(
      qc,
      created({ threadId: undefined, conversationId: conv, messageId: "y", seq: 2 }),
    );

    expect(threadPage0(qc, conv).map((m) => m.id)).toEqual(["x", "y"]);
  });
});

describe("patchInboxOnIgnored", () => {
  it("drops the matching THREAD row when scoped to a threadId", () => {
    const keep = inboxItem({ refId: "keep-0000-0000-0000-0000-0000000000bb" });
    seedInbox(qc, [inboxItem(), keep]);

    patchInboxOnIgnored(qc, { threadId: THREAD } as unknown as ConversationIgnored);

    expect(inboxRows(qc).map((i) => i.refId)).toEqual([keep.refId]);
  });
});

describe("patchThreadOnDelivered", () => {
  it("bumps the targeted bubble to DELIVERED but leaves a SEEN bubble alone", () => {
    seedThread(qc, THREAD, [
      [dto({ id: "m1", seq: 1, status: "SENT" }), dto({ id: "m2", seq: 2, status: "SEEN" })],
    ]);

    patchThreadOnDelivered(qc, {
      threadId: THREAD,
      messageId: "m1",
    } as unknown as MessageDelivered);
    patchThreadOnDelivered(qc, {
      threadId: THREAD,
      messageId: "m2",
    } as unknown as MessageDelivered);

    const page0 = threadPage0(qc, THREAD);
    expect(page0.find((m) => m.id === "m1")!.status).toBe("DELIVERED");
    expect(page0.find((m) => m.id === "m2")!.status).toBe("SEEN"); // never downgraded
  });
});

describe("patchThreadOnRead", () => {
  it("flips only MY bubbles with seq <= upToSeq to SEEN", () => {
    seedThread(qc, THREAD, [
      [
        dto({ id: "mine1", seq: 1, senderId: ME, status: "DELIVERED" }),
        dto({ id: "mine2", seq: 2, senderId: ME, status: "DELIVERED" }),
        dto({ id: "mine3", seq: 3, senderId: ME, status: "DELIVERED" }),
        dto({ id: "theirs", seq: 2, senderId: PEER, status: "DELIVERED" }),
      ],
    ]);

    patchThreadOnRead(qc, { threadId: THREAD, upToSeq: 2 } as unknown as MessageRead, ME);

    const byId = Object.fromEntries(threadPage0(qc, THREAD).map((m) => [m.id, m.status]));
    expect(byId.mine1).toBe("SEEN"); // seq 1 <= 2, mine
    expect(byId.mine2).toBe("SEEN"); // seq 2 <= 2, mine
    expect(byId.mine3).toBe("DELIVERED"); // seq 3 > 2, untouched
    expect(byId.theirs).toBe("DELIVERED"); // not mine, untouched
  });
});

describe("patchOnDismissed", () => {
  it("marks only the dismissed message's bubble dismissedBySender", () => {
    seedThread(qc, THREAD, [[dto({ id: "keep", seq: 1 }), dto({ id: "gone", seq: 2 })]]);

    patchOnDismissed(qc, { threadId: THREAD, messageId: "gone" } as unknown as MessageDismissed);

    const page0 = threadPage0(qc, THREAD);
    expect(page0.find((m) => m.id === "gone")!.dismissedBySender).toBe(true);
    expect(page0.find((m) => m.id === "keep")!.dismissedBySender).toBeUndefined();
  });
});
