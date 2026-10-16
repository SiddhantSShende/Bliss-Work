/**
 * The bridge resyncs the caches when the web socket comes back after being down
 * (sleep, network loss, gateway deploy) — the replay is only 200 events deep.
 * It must not do so on the first connect, and the Electron host (which hands the
 * renderer events but no socket status) is left alone.
 */
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsStatus } from "@taskboard/shared";
import { RESYNC_DELAY_MS } from "./reconnectResync";
import { WsEventBridge } from "./queryBridge";

const rt = vi.hoisted(() => ({
  status: undefined as ((s: WsStatus) => void) | undefined,
  offStatus: vi.fn(),
  config: {} as Record<string, unknown>,
}));

vi.mock("sonner", () => ({ toast: Object.assign(() => {}, { info: () => {}, error: () => {}, success: () => {} }) }));
vi.mock("./runtime", () => ({
  useRuntime: () => ({
    config: rt.config,
    api: { myRingingCalls: () => Promise.resolve([]) },
    ws: {
      connect: () => Promise.resolve(),
      close: () => {},
      on: () => () => {},
      onStatus: (cb: (s: WsStatus) => void) => {
        rt.status = cb;
        return rt.offStatus;
      },
    },
  }),
}));
vi.mock("../store/session", () => ({
  useSession: Object.assign(
    (sel: (s: { user: { id: string; orgId: string } }) => unknown) => sel({ user: { id: "me", orgId: "org" } }),
    { getState: () => ({ user: { id: "me", orgId: "org" } }) },
  ),
}));

function mount() {
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <WsEventBridge />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { invalidate, view };
}

const emit = (s: WsStatus) => act(() => rt.status?.(s));

beforeEach(() => {
  vi.useFakeTimers();
  rt.status = undefined;
  rt.offStatus.mockClear();
  rt.config = {};
});
afterEach(() => vi.useRealTimers());

describe("WsEventBridge reconnect resync", () => {
  it("invalidates the pushed caches after the socket reconnects, but not on first connect", () => {
    const { invalidate } = mount();

    emit("connecting");
    emit("open");
    act(() => void vi.advanceTimersByTime(RESYNC_DELAY_MS * 2));
    expect(invalidate).not.toHaveBeenCalled();

    emit("closed");
    emit("connecting");
    emit("open");
    act(() => void vi.advanceTimersByTime(RESYNC_DELAY_MS));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("stops listening to socket status when the bridge unmounts", () => {
    const { view } = mount();
    view.unmount();
    expect(rt.offStatus).toHaveBeenCalled();
  });

  it("leaves the Electron event source alone (it has no socket status to watch)", () => {
    rt.config = { eventSource: { connect: () => {}, subscribe: () => () => {} } };
    mount();
    expect(rt.status).toBeUndefined();
  });
});
