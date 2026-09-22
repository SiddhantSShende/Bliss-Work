/**
 * A resumed draft is read through qk.mail(id) with an infinite staleTime, and the
 * composer is its only writer. Autosave wrote the server copy but left that cache
 * entry as it was on first open, so closing and reopening the draft filled the
 * form from the stale copy and the next autosave overwrote the newer text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  api: {
    createMailDraft: vi.fn(),
    saveMailDraft: vi.fn(),
    discardMailDraft: vi.fn(),
  },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));

import { qk } from "../lib/queryBridge";
import { useMailDraft, type MailDraftContent } from "./useMailDraft";

const content = (over: Partial<MailDraftContent> = {}): MailDraftContent => ({
  to: ["bob@company.com"],
  cc: [],
  bcc: [],
  subject: "Edited subject",
  bodyText: "Edited body",
  hasAttachments: false,
  ...over,
});

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);
const STALE_COPY = { mailId: "d1", subject: "Old subject", bodyText: "Old body" };

beforeEach(() => {
  vi.useFakeTimers();
  // No observers here, so without this the fake clock would garbage-collect the entries under test.
  qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  qc.setQueryData(qk.mail("d1"), STALE_COPY);
  h.api.saveMailDraft.mockReset().mockResolvedValue(undefined);
  h.api.discardMailDraft.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

async function closeComposer(unmount: () => void) {
  unmount();
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

describe("useMailDraft and the cached copy of a resumed draft", () => {
  it("drops the stale cached copy once the edits are saved on close", async () => {
    const { result, unmount } = renderHook(() => useMailDraft("d1"), { wrapper });
    act(() => result.current.save(content()));

    await closeComposer(unmount);

    expect(h.api.saveMailDraft).toHaveBeenCalledWith("d1", expect.objectContaining({ subject: "Edited subject" }));
    expect(qc.getQueryData(qk.mail("d1"))).toBeUndefined();
  });

  it("drops it when the draft is emptied and discarded on close", async () => {
    const { result, unmount } = renderHook(() => useMailDraft("d1"), { wrapper });
    act(() => result.current.save(content({ to: [], subject: "", bodyText: "" })));

    await closeComposer(unmount);

    expect(h.api.discardMailDraft).toHaveBeenCalledWith("d1");
    expect(qc.getQueryData(qk.mail("d1"))).toBeUndefined();
  });

  it("drops it on an explicit discard", async () => {
    const { result } = renderHook(() => useMailDraft("d1"), { wrapper });

    await act(async () => {
      await result.current.discard();
    });

    expect(qc.getQueryData(qk.mail("d1"))).toBeUndefined();
  });

  it("leaves other drafts' cached copies alone", async () => {
    qc.setQueryData(qk.mail("d2"), { mailId: "d2" });
    const { result, unmount } = renderHook(() => useMailDraft("d1"), { wrapper });
    act(() => result.current.save(content()));

    await closeComposer(unmount);

    expect(qc.getQueryData(qk.mail("d2"))).toEqual({ mailId: "d2" });
  });

  it("does not discard a resumed draft closed before its content ever loaded", async () => {
    // A slow network or a load error can close the composer before `save()`
    // has ever run once (see the effect in MailCompose.tsx that gates on
    // `resumed.data`) — contentRef.current is still null then, and treating
    // that as "empty" would delete a draft that already has real content
    // server-side.
    const { unmount } = renderHook(() => useMailDraft("d1"), { wrapper });

    await closeComposer(unmount);

    expect(h.api.discardMailDraft).not.toHaveBeenCalled();
    expect(h.api.saveMailDraft).not.toHaveBeenCalled();
    // Nothing was learned about this draft, so the cached copy is left as-is
    // too, rather than dropped for no reason.
    expect(qc.getQueryData(qk.mail("d1"))).toEqual(STALE_COPY);
  });

  it("does not touch the cache when the mail was sent (send invalidates it itself)", async () => {
    const { result, unmount } = renderHook(() => useMailDraft("d1"), { wrapper });
    act(() => {
      result.current.save(content());
      result.current.markSent();
    });

    await closeComposer(unmount);

    expect(h.api.saveMailDraft).not.toHaveBeenCalled();
    expect(qc.getQueryData(qk.mail("d1"))).toEqual(STALE_COPY);
  });
});
