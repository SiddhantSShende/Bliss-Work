import type { ReactNode } from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "./queryKeys";
import { noteLivePresence, noteLiveSnapshot } from "./presenceFreshness";

const h = vi.hoisted(() => ({
  presenceOf: vi.fn<(ids: string[]) => Promise<string[]>>(),
}));
vi.mock("./runtime", () => ({ useRuntime: () => ({ api: { presenceOf: h.presenceOf } }) }));

import { usePresence } from "./usePresence";

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

/** Let the poll's continuation and react-query's batched notifications run. */
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 30)));

/** Make the next presenceOf() hang until the test answers it. */
function deferPoll() {
  let answer!: (online: string[]) => void;
  h.presenceOf.mockImplementationOnce(() => new Promise<string[]>((r) => (answer = r)));
  return (online: string[]) => answer(online);
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seeded so the canonical (staleTime: Infinity) query never runs its own
  // queryFn and races the poll's write — it only subscribes.
  qc.setQueryData(qk.presence, []);
  h.presenceOf.mockReset();
  // The snapshot stamp is module state shared by all tests: move it far back.
  noteLiveSnapshot(0);
});

describe("usePresence poll vs live events", () => {
  it("applies a poll answer when nothing live happened meanwhile", async () => {
    h.presenceOf.mockResolvedValueOnce(["a"]);
    const { result } = renderHook(() => usePresence(["a", "b"]), { wrapper });
    await waitFor(() => expect([...result.current]).toEqual(["a"]));
  });

  it("does not let a poll that started BEFORE a live event overwrite it", async () => {
    qc.setQueryData(qk.presence, ["a"]);
    const answer = deferPoll();
    const { result } = renderHook(() => usePresence(["a", "b"]), { wrapper });
    await waitFor(() => expect(h.presenceOf).toHaveBeenCalledTimes(1));

    // While the request is in flight: `a` goes offline and `b` comes online, live.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
      noteLivePresence("a");
      noteLivePresence("b");
      qc.setQueryData(qk.presence, ["b"]);
    });
    // The server computed this before those events: it still says a online, b offline.
    answer(["a"]);
    await settle();

    expect([...result.current]).toEqual(["b"]);
  });

  it("still reconciles ids no live event touched, even when others were", async () => {
    const answer = deferPoll();
    const { result } = renderHook(() => usePresence(["a", "b", "c"]), { wrapper });
    await waitFor(() => expect(h.presenceOf).toHaveBeenCalledTimes(1));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
      noteLivePresence("a"); // a live event for a only
    });
    await act(async () => answer(["a", "c"]));

    await waitFor(() => expect([...result.current].sort()).toEqual(["c"])); // c taken from the poll, a left to the event
  });

  it("drops the whole answer when a live snapshot replaced the set meanwhile", async () => {
    const answer = deferPoll();
    const { result } = renderHook(() => usePresence(["a", "b"]), { wrapper });
    await waitFor(() => expect(h.presenceOf).toHaveBeenCalledTimes(1));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
      noteLiveSnapshot();
      qc.setQueryData(qk.presence, ["b"]);
    });
    answer(["a"]);
    await settle();

    expect([...result.current]).toEqual(["b"]);
  });
});
