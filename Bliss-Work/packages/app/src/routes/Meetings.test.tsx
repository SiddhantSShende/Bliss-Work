/**
 * Regression test: myCalls() has no isError handling. z.array(CallDTO) fails
 * its ENTIRE parse if even one row is malformed, so one bad row silently
 * emptied the whole list into "Nothing scheduled" — a real fact about an
 * empty calendar and a failed request must not read the same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = { myCalls: vi.fn() };
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));
vi.mock("../lib/useGoBack", () => ({ useGoBack: () => () => {} }));
vi.mock("../lib/callWindow", () => ({ openCallTab: vi.fn() }));
vi.mock("../lib/MeetingSession", () => ({
  useMeetingSession: () => ({ enter: vi.fn(), restore: vi.fn(), call: null }),
}));
vi.mock("../features/ScheduleCallDialog", () => ({ ScheduleCallDialog: () => null }));
vi.mock("../features/MeetingCard", () => ({ MeetingCard: () => null }));

import { Meetings } from "./Meetings";

function renderMeetings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Meetings />
    </QueryClientProvider>,
  );
}

describe("Meetings: myCalls() failure handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a genuine error state, not 'Nothing scheduled', when the request fails", async () => {
    api.myCalls.mockRejectedValue(new Error("502"));
    renderMeetings();

    expect(await screen.findByText("Couldn't load your meetings.")).toBeTruthy();
    expect(screen.queryByText("Nothing scheduled")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("still shows the real empty state on a genuinely empty, successful response", async () => {
    api.myCalls.mockResolvedValue([]);
    renderMeetings();

    expect(await screen.findByText("Nothing scheduled")).toBeTruthy();
  });

  it("retry re-issues the request", async () => {
    api.myCalls.mockRejectedValueOnce(new Error("502")).mockResolvedValueOnce([]);
    renderMeetings();

    await screen.findByText("Couldn't load your meetings.");
    screen.getByRole("button", { name: "Retry" }).click();

    await waitFor(() => expect(api.myCalls).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Nothing scheduled")).toBeTruthy();
  });
});
