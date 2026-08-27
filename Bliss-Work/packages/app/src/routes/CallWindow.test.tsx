/**
 * A hard refresh landing directly on /call/:callId is the one path that
 * re-enters a meeting with no click at all — enter() used to fire for ANY
 * call it fetched, including one that had already ended while the tab was
 * gone. RejoinPrompt (MeetingHost.tsx) already excludes ENDED/CANCELLED from
 * its own reload-recovery offer; these tests pin CallWindow doing the same,
 * instead of handing a dead call to the room and letting it discover that
 * later via a LiveKit connect timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = { call: vi.fn() };
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api }) }));

const enter = vi.fn();
vi.mock("../lib/MeetingSession", () => ({
  useMeetingSession: () => ({ enter, call: null }),
}));

vi.mock("../lib/callWindow", () => ({
  OPENED_BY_APP_PARAM: "opened",
  closeMeetingTab: (fallback: () => void) => fallback(),
  rememberMeetingTab: vi.fn(),
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

  it("hands a live call straight to the meeting session", async () => {
    api.call.mockResolvedValue({ id: "c1", title: "Standup", status: "ACTIVE" });
    renderAt("c1");

    await waitFor(() => expect(enter).toHaveBeenCalledTimes(1));
    expect(enter.mock.calls[0]![0]).toMatchObject({ id: "c1", status: "ACTIVE" });
  });

  it("does not enter a call that already ended", async () => {
    api.call.mockResolvedValue({ id: "c1", title: "Standup", status: "ENDED" });
    renderAt("c1");

    expect(await screen.findByText("This meeting isn't available")).toBeTruthy();
    expect(enter).not.toHaveBeenCalled();
  });

  it("does not enter a call that was cancelled", async () => {
    api.call.mockResolvedValue({ id: "c1", title: "Standup", status: "CANCELLED" });
    renderAt("c1");

    expect(await screen.findByText("This meeting isn't available")).toBeTruthy();
    expect(enter).not.toHaveBeenCalled();
  });

  it("still shows the unavailable state for a call that failed to load at all", async () => {
    api.call.mockRejectedValue(new Error("not found"));
    renderAt("c1");

    // CallWindow's own query sets retry: 1 (staler than the QueryClient
    // default here), so this settles after one retry backoff — past RTL's
    // default 1000ms findBy timeout.
    expect(
      await screen.findByText("This meeting isn't available", {}, { timeout: 5000 }),
    ).toBeTruthy();
    expect(enter).not.toHaveBeenCalled();
  });
});
