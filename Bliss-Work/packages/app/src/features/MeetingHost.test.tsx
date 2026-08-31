/**
 * Regression test: clicking "Join"/"Open" on a call-started/call-waiting/ring
 * notification toast (queryBridge.tsx -> requestMeetingJoin -> here) used to
 * do NOTHING at all if api.call() failed for any reason — no error, no room,
 * no feedback. This is the only feedback surface that click has.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { requestMeetingJoin } from "../lib/MeetingSession";

const api = { call: vi.fn() };
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api }) }));

const enter = vi.fn();
const exit = vi.fn();
vi.mock("../lib/MeetingSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/MeetingSession")>();
  return {
    ...actual,
    useMeetingSession: () => ({ call: null, enter, exit, autoJoinMedia: null }),
  };
});

vi.mock("../lib/callWindow", () => ({ closeMeetingTab: vi.fn() }));
vi.mock("./CallRoomLazy", () => ({ CallRoom: () => null }));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: (...a: unknown[]) => toastError(...a) }) }));

import { MeetingHost } from "./MeetingHost";

// RejoinPrompt (rendered alongside the toast-join path whenever there is no
// active call) uses useQuery too, so every render needs a real QueryClient.
function renderHost() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MeetingHost />
    </QueryClientProvider>,
  );
}

describe("MeetingHost: notification-toast join path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enters the meeting when the call fetch succeeds", async () => {
    api.call.mockResolvedValue({ id: "c1", status: "LIVE" });
    renderHost();

    requestMeetingJoin("c1");

    await waitFor(() =>
      expect(enter).toHaveBeenCalledWith({ id: "c1", status: "LIVE" }, undefined, undefined),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("passes the Video/Voice choice through to enter, for CallRoom's autoJoin", async () => {
    // This is how the incoming-meeting popup's Video Call / Voice Call
    // buttons reach the room — see IncomingMeetingNotice.
    api.call.mockResolvedValue({ id: "c1", status: "LIVE" });
    renderHost();

    requestMeetingJoin("c1", "voice");

    await waitFor(() =>
      expect(enter).toHaveBeenCalledWith({ id: "c1", status: "LIVE" }, undefined, "voice"),
    );
  });

  it("shows an error instead of silently doing nothing when the call fetch fails", async () => {
    api.call.mockRejectedValue(new Error("network down"));
    renderHost();

    requestMeetingJoin("c1");

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("network down"));
    expect(enter).not.toHaveBeenCalled();
  });

  it("does not enter a call that has already ended", async () => {
    api.call.mockResolvedValue({ id: "c1", status: "ENDED" });
    renderHost();

    requestMeetingJoin("c1");

    await waitFor(() => expect(api.call).toHaveBeenCalledWith("c1"));
    expect(enter).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("only acts on the latest of two rapid requests", async () => {
    let resolveFirst!: (v: { id: string; status: string }) => void;
    api.call
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce({ id: "c2", status: "LIVE" });
    renderHost();

    requestMeetingJoin("c1");
    requestMeetingJoin("c2");
    await waitFor(() =>
      expect(enter).toHaveBeenCalledWith({ id: "c2", status: "LIVE" }, undefined, undefined),
    );

    // The first (superseded) request resolving afterwards must not also enter.
    resolveFirst({ id: "c1", status: "LIVE" });
    await new Promise((r) => setTimeout(r, 0));
    expect(enter).toHaveBeenCalledTimes(1);
  });
});
