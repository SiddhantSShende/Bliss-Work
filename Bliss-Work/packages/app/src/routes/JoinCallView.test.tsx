/**
 * Regression tests for the "stuck on Joining the meeting…" bug reported for
 * meeting links opened from chat/channel via "Continue in Browser".
 *
 * This route hands the call off to MeetingHost via useMeetingSession().enter()
 * rather than rendering CallRoom itself, unlike routes/CallWindow.tsx — see
 * that file's own doc comment for why it moved away from this hand-off
 * pattern. Because this route still uses it, it needs a runtime guard
 * instead (JoinCallView.tsx's own HANDOFF_TIMEOUT_MS comment) for the same
 * failure: it is reached the same cold-load way, from a link outside the
 * running app.
 */
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const api = { joinCallByToken: vi.fn() };
const ws = { connect: vi.fn(async () => {}) };
// config: { kind: "web" } (no eventSource) matches CallWindow.test.tsx's own
// mock. useConnectEventBridge is mocked to go straight to ws.connect(), the
// branch it takes for this config shape, since WsEventBridge (the only other
// caller of connect()) never mounts on this route either.
vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api, ws, config: { kind: "web" } }),
  useConnectEventBridge: () => useEffect(() => void ws.connect(), []),
}));

vi.mock("../store/session", () => ({
  useSession: (select: (s: unknown) => unknown) =>
    select({ status: "authed", user: { id: "me", displayName: "Me" } }),
}));

const enter = vi.fn();
vi.mock("../lib/MeetingSession", () => ({
  useMeetingSession: () => ({ enter, call: null }),
}));

import { JoinCallView } from "./JoinCallView";

function renderAt(query: string) {
  return render(
    <MemoryRouter initialEntries={[`/join${query}`]}>
      <Routes>
        <Route path="/join" element={<JoinCallView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("JoinCallView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands the redeemed call off to the meeting session", async () => {
    api.joinCallByToken.mockResolvedValue({ id: "c1", title: "Standup", status: "ACTIVE" });
    renderAt("?t=tok&via=browser");

    await screen.findByText("Joining the meeting…");
    expect(enter).toHaveBeenCalledTimes(1);
    expect(enter.mock.calls[0]![0]).toMatchObject({ id: "c1" });
  });

  // Regression: this route sits OUTSIDE /app (see App.tsx's own doc), so
  // WsEventBridge never mounts here — same gap CallWindow.tsx had for
  // /call/:callId until it grew this exact fix. Without it, someone joining
  // by link never hears CallStarted (the pre-join lobby's auto-join) or
  // CallEnded live, only ever the 30s lobby-poll fallback.
  it("connects the socket on mount, since nothing else on this route does", async () => {
    api.joinCallByToken.mockResolvedValue({ id: "c1", title: "Standup", status: "ACTIVE" });
    renderAt("?t=tok&via=browser");

    await screen.findByText("Joining the meeting…");
    expect(ws.connect).toHaveBeenCalledTimes(1);
  });

  // Regression: the actual reported bug. enter() only sets context state and
  // trusts MeetingHost, mounted elsewhere, to pick it up — a hiccup anywhere
  // in that hand-off used to leave this static text on screen forever with no
  // error and no way out.
  it("offers a reload once the handoff takes longer than HANDOFF_TIMEOUT_MS", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.joinCallByToken.mockResolvedValue({ id: "c1", title: "Standup", status: "ACTIVE" });
    renderAt("?t=tok&via=browser");

    await screen.findByText("Joining the meeting…");
    // A comfortable margin past HANDOFF_TIMEOUT_MS (15s), matching
    // CallWindow.test.tsx's own 20s advance for the same 15s timeout — avoids
    // the exact-boundary edge case of advancing by precisely the delay.
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await screen.findByText("This is taking longer than expected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    vi.useRealTimers();
  });

  it("does not show the reload fallback before the timeout elapses", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.joinCallByToken.mockResolvedValue({ id: "c1", title: "Standup", status: "ACTIVE" });
    renderAt("?t=tok&via=browser");

    await screen.findByText("Joining the meeting…");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(screen.getByText("Joining the meeting…")).toBeTruthy();
    expect(screen.queryByText("This is taking longer than expected")).toBeNull();
    vi.useRealTimers();
  });
});
