import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { useOptimisticSend } from "./useOptimisticSend";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

interface Row {
  id: string;
  seq: number;
  body: string;
  status?: string;
}
const KEY = ["messages", "c1"] as const;

function setup(initial: Row[], send: () => Promise<{ messageId: string; seq: number }>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(KEY, initial);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () =>
      useOptimisticSend<Row>({
        queryKey: KEY,
        buildOptimistic: (id, { body }, prev) => ({ id, seq: prev.length + 1, body }),
        mutationFn: send,
        reconcile: (m) => ({ ...m, status: "SENT" }),
      }),
    { wrapper },
  );
  return { qc, result };
}

describe("useOptimisticSend reconciliation", () => {
  it("swaps the temp row's id and seq for the server's", async () => {
    const { qc, result } = setup([], async () => ({ messageId: "real", seq: 7 }));
    await act(() => result.current.mutateAsync({ body: "hi" }));
    expect(qc.getQueryData(KEY)).toEqual([{ id: "real", seq: 7, body: "hi", status: "SENT" }]);
  });

  it("does not leave two rows with one id when the socket echo got in first", async () => {
    let finish!: (v: { messageId: string; seq: number }) => void;
    const { qc, result } = setup([], () => new Promise((r) => (finish = r)));
    act(() => void result.current.mutate({ body: "hi" }));
    await waitFor(() => expect(qc.getQueryData<Row[]>(KEY)).toHaveLength(1));

    // queryBridge appended the echo under the real id while the send was pending.
    qc.setQueryData<Row[]>(KEY, (prev) => [...(prev ?? []), { id: "real", seq: 7, body: "hi!" }]);
    await act(async () => finish({ messageId: "real", seq: 7 }));

    await waitFor(() =>
      expect(qc.getQueryData(KEY)).toEqual([{ id: "real", seq: 7, body: "hi!", status: "SENT" }]),
    );
  });
});
