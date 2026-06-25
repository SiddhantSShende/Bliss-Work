/**
 * Pure-function unit tests for the thread-history infinite-query wrapper.
 *
 * useInfiniteQuery itself is React-Query's responsibility; here we test the
 * non-trivial bits that ARE ours: the page-size constant, and the
 * getNextPageParam logic that decides when we've reached the head of a thread.
 *
 * The whole point of the 16 → 12 change is server load — and the load only
 * drops if the client actually stops asking when it sees a short page. The
 * second test pins that invariant.
 */
import { describe, expect, it } from "vitest";
import type { MessageDTO } from "@taskboard/shared";
import { THREAD_PAGE_SIZE } from "./useCursorPagination";

// Re-derive the predicate so we can test it without spinning up a real
// QueryClient. Keeping it identical to the inline lambda in useThreadMessages
// is a tradeoff — if the lambda changes, this test needs to follow. The shape
// is small enough that the duplication is cheap.
function deriveNextBeforeSeq(
  lastPage: MessageDTO[],
  allPages: MessageDTO[][],
  pageSize: number = THREAD_PAGE_SIZE,
): number | undefined {
  if (!lastPage.length || lastPage.length < pageSize) return undefined;
  return Math.min(...allPages.flat().map((m) => m.seq));
}

function msg(seq: number): MessageDTO {
  // The DTO has many fields; tests only need `seq`. Cast to MessageDTO so the
  // helper composes — the predicate never reads anything else.
  return { seq } as unknown as MessageDTO;
}

describe("THREAD_PAGE_SIZE", () => {
  it("is 12 — matches services/messaging-svc/internal/api/threads.go DefaultThreadPageSize", () => {
    expect(THREAD_PAGE_SIZE).toBe(12);
  });
});

describe("useThreadMessages.getNextPageParam (derived)", () => {
  it("returns undefined when the last page is empty (head of thread)", () => {
    const allPages: MessageDTO[][] = [[msg(50), msg(49), msg(48)]];
    expect(deriveNextBeforeSeq([], allPages)).toBeUndefined();
  });

  it("returns undefined when the last page is shorter than pageSize", () => {
    // 11 < 12 → we know there isn't another full page upstream.
    const lastPage = Array.from({ length: 11 }, (_, i) => msg(11 - i));
    expect(deriveNextBeforeSeq(lastPage, [lastPage])).toBeUndefined();
  });

  it("returns the global min seq when the last page is full", () => {
    const newest = Array.from({ length: 12 }, (_, i) => msg(100 - i));
    const older = Array.from({ length: 12 }, (_, i) => msg(88 - i));
    expect(deriveNextBeforeSeq(older, [newest, older])).toBe(77);
  });

  it("respects a custom pageSize (used in tests)", () => {
    // With pageSize=4, a page of exactly 4 means "more upstream", but only 3
    // means "head of thread reached".
    const four = [msg(20), msg(19), msg(18), msg(17)];
    const three = [msg(16), msg(15), msg(14)];
    expect(deriveNextBeforeSeq(four, [four], 4)).toBe(17);
    expect(deriveNextBeforeSeq(three, [four, three], 4)).toBeUndefined();
  });
});
