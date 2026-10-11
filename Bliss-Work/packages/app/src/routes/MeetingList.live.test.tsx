/**
 * The Live tab of the meeting list.
 *
 * What the server reports as live is what is shown; a meeting the server
 * reports as over is not, whatever else its row says; and one that runs out
 * while the page is open is dropped by asking the server again — not by the
 * list deciding for itself from the local clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CallDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({
  api: { myCalls: vi.fn(), myCallHistory: vi.fn() },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: { user: { id: string } }) => unknown) => sel({ user: { id: "viewer" } }),
}));
vi.mock("../lib/userLabel", () => ({
  useUserLabels: () => ({ nameOf: (id: string) => id, avatarUrlOf: () => null }),
}));
vi.mock("../features/MeetingFilterMenu", () => ({ MeetingFilterMenu: () => null }));
// The row is its own unit; here it is only a marker for "this call is listed".
vi.mock("../features/MeetingRow", () => ({
  MeetingRow: ({ call }: { call: CallDTO }) => <li data-testid="row">{call.title}</li>,
}));

import { MeetingList } from "./MeetingList";

const call = (over: Partial<CallDTO>): CallDTO =>
  ({
    id: "00000000-0000-4000-8000-000000000901",
    orgId: "00000000-0000-4000-8000-000000000999",
    kind: "CHANNEL",
    title: "x",
    media: "video",
    createdBy: "00000000-0000-4000-8000-000000000001",
    scheduledAt: null,
    endsAt: null,
    startedAt: null,
    startedBy: null,
    endedAt: null,
    status: "LIVE",
    createdAt: "2026-09-29T09:00:00.000Z",
    participants: [],
    activeShares: [],
    channelIds: [],
    ...over,
  }) as CallDTO;

function renderLive() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/app/meetings?view=live"]}>
        <MeetingList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rows = () => screen.queryAllByTestId("row").map((r) => r.textContent);

beforeEach(() => {
  h.api.myCalls.mockReset();
  h.api.myCallHistory.mockReset().mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("MeetingList — Live", () => {
  it("lists only what is genuinely live", async () => {
    h.api.myCalls.mockResolvedValue([
      call({ id: "00000000-0000-4000-8000-000000000a01", title: "active", status: "LIVE" }),
      call({ id: "00000000-0000-4000-8000-000000000a02", title: "ended", status: "ENDED", endedAt: "2026-09-29T10:00:00.000Z" }),
      call({ id: "00000000-0000-4000-8000-000000000a03", title: "stale", status: "LIVE", endedAt: "2026-09-29T10:00:00.000Z" }),
      call({ id: "00000000-0000-4000-8000-000000000a04", title: "upcoming", status: "SCHEDULED" }),
      call({ id: "00000000-0000-4000-8000-000000000a05", title: "cancelled", status: "CANCELLED" }),
    ]);
    renderLive();

    await screen.findByText("active");
    expect(rows()).toEqual(["active"]);
  });

  it("drops a meeting that runs out while the page is open, once the server says so", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const id = "00000000-0000-4000-8000-000000000b01";
    const endsAt = new Date(Date.now() + 60_000).toISOString();
    h.api.myCalls
      .mockResolvedValueOnce([call({ id, title: "closing", status: "LIVE", endsAt })])
      .mockResolvedValue([call({ id, title: "closing", status: "ENDED", endsAt, endedAt: endsAt })]);
    renderLive();

    await screen.findByText("closing");
    expect(h.api.myCalls).toHaveBeenCalledTimes(1);

    // Not removed by the clock on its own: the list asks, then shows the answer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(62_000);
    });
    expect(h.api.myCalls).toHaveBeenCalledTimes(2);
    expect(rows()).toEqual([]);
  });

  it("keeps showing a meeting the server still reports live past its end by this clock", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const id = "00000000-0000-4000-8000-000000000c01";
    const endsAt = new Date(Date.now() - 5 * 60_000).toISOString();
    h.api.myCalls.mockResolvedValue([call({ id, title: "skewed", status: "LIVE", endsAt })]);
    renderLive();

    await screen.findByText("skewed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    // Re-asked at the sweeper's pace, not in a tight loop, and still listed.
    expect(h.api.myCalls.mock.calls.length).toBeLessThanOrEqual(3);
    expect(rows()).toEqual(["skewed"]);
  });
});
