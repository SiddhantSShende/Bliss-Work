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

  it("offers a reload if the meeting overlay never takes over within the handoff window", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.call.mockResolvedValue({ id: "c1", title: "Standup", status: "ACTIVE" });
    renderAt("c1");

    await vi.advanceTimersByTimeAsync(15_000);

    expect(await screen.findByText("This is taking longer than expected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    vi.useRealTimers();
  });

  it("the handoff-timeout reload button reloads the page", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.call.mockResolvedValue({ id: "c1", title: "Standup", status: "ACTIVE" });
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    renderAt("c1");

    await vi.advanceTimersByTimeAsync(15_000);
    (await screen.findByRole("button", { name: "Reload" })).click();

    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
