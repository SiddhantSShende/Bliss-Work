/**
 * CallWindow renders CallRoom directly now — see the file's own doc for why
 * the previous `enter()`/MeetingHost hand-off was replaced. These tests pin:
 * the room is only rendered for a call that is actually joinable, and a call
 * that fails to load gets a distinct, retryable error rather than the same
 * "meeting isn't available" text a genuinely-ended call gets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = { call: vi.fn() };
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api }) }));

vi.mock("../lib/callWindow", () => ({
  OPENED_BY_APP_PARAM: "opened",
  closeMeetingTab: (fallback: () => void) => fallback(),
  rememberMeetingTab: vi.fn(),
}));

const roomProps = vi.fn();
vi.mock("../features/CallRoomLazy", () => ({
  CallRoom: (props: { call: { id: string }; onClose: () => void }) => {
    roomProps(props);
    return <div data-testid="call-room">room for {props.call.id}</div>;
  },
}));

import { CallWindow } from "./CallWindow";

function renderAt(callId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/call/${callId}`]}>
        <Routes>
          <Route path="/call/:callId" element={<CallWindow />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("CallWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders CallRoom directly once a live call loads", async () => {
    api.call.mockResolvedValue({ id: "c1", title: "Standup", status: "ACTIVE" });
    renderAt("c1");

    expect(await screen.findByTestId("call-room")).toBeTruthy();
    expect(roomProps.mock.calls[0]![0]).toMatchObject({ call: { id: "c1", status: "ACTIVE" } });
  });

  it("does not render the room for a call that already ended", async () => {
    api.call.mockResolvedValue({ id: "c1", title: "Standup", status: "ENDED" });
    renderAt("c1");

    expect(await screen.findByText("This meeting isn't available")).toBeTruthy();
    expect(screen.queryByTestId("call-room")).toBeNull();
  });

  it("does not render the room for a call that was cancelled", async () => {
    api.call.mockResolvedValue({ id: "c1", title: "Standup", status: "CANCELLED" });
    renderAt("c1");

    expect(await screen.findByText("This meeting isn't available")).toBeTruthy();
    expect(screen.queryByTestId("call-room")).toBeNull();
  });

  it("shows a distinct, retryable error when the call fails to load", async () => {
    api.call.mockRejectedValue(new Error("not found"));
    renderAt("c1");

    // CallWindow's own query sets retry: 1, so this settles after one retry
    // backoff — past RTL's default 1000ms findBy timeout (see CallWindow.tsx).
    expect(
      await screen.findByText("Unable to load this meeting.", {}, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.queryByTestId("call-room")).toBeNull();

    api.call.mockResolvedValue({ id: "c1", title: "Standup", status: "ACTIVE" });
    screen.getByText("Retry").click();

    expect(await screen.findByTestId("call-room")).toBeTruthy();
  });

  // Regression test: an earlier attempt at this fix added a blanket 15s
  // "handoff timeout" that unmounted CallRoom (and, per useCallRoom's cleanup,
  // disconnected and posted a leave) if it fired, with no regard for whether
  // the room had already connected. It fired unconditionally 15s after the
  // call loaded, which ended live, successfully-connected meetings out from
  // under people mid-call. There is no substitute assertion for "no such
  // timeout exists" — this pins that a call which stays mounted well past 15s
  // keeps rendering the room rather than being torn down from underneath.
  it("does not tear the room down after 15s while the call is still live", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.call.mockResolvedValue({ id: "c1", title: "Standup", status: "ACTIVE" });
    renderAt("c1");

    expect(await screen.findByTestId("call-room")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(screen.getByTestId("call-room")).toBeTruthy();
    vi.useRealTimers();
  });
});
