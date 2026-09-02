/**
 * The calendar page.
 *
 * The things worth a failing test here are not that a grid renders. They are
 * the three promises the page makes that are easy to break silently:
 *
 *  1. It reads the WINDOW it is showing. The old reads could not serve a
 *     calendar — `myCalls()` caps finished meetings at a month, so a week
 *     navigated back past one renders as an empty week that is not empty. If
 *     this page ever falls back to that read, nothing throws; the calendar just
 *     quietly stops having a past.
 *  2. Navigation actually re-asks. "Next week" that moves the heading but not
 *     the request shows last week's meetings under next week's dates.
 *  3. The list underneath keeps its own sources. It answers "what am I expected
 *     at", which must not empty out because somebody paged the grid to March.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CallDTO } from "@taskboard/shared";

const api = {
  myCallsInRange: vi.fn(),
  myCalls: vi.fn(),
  myCallHistory: vi.fn(),
};
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: unknown) => unknown) => sel({ user: { id: "u-me", orgId: "org-1" } }),
}));
vi.mock("../lib/userLabel", () => ({
  useUserLabels: () => ({
    nameOf: (id: string) => ({ "u-m": "Mayank", "u-me": "Me" })[id] ?? id,
    avatarUrlOf: () => null,
  }),
}));
vi.mock("../lib/callWindow", () => ({ openCallTab: vi.fn(() => false) }));
vi.mock("../lib/MeetingSession", () => ({
  useMeetingSession: () => ({ enter: vi.fn(), restore: vi.fn(), call: null }),
}));
vi.mock("../features/NewMeetingDialog", () => ({ NewMeetingDialog: () => null }));

import { MeetingsCalendar } from "./MeetingsCalendar";

/** A local wall-clock instant — the calendar draws the viewer's own clock, so
 *  the fixtures are built in it rather than parsed from UTC. */
function at(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min).getTime();
}

function call(over: Partial<CallDTO> = {}): CallDTO {
  return {
    id: "c-1",
    orgId: "org-1",
    kind: "MEETING",
    title: "Planning",
    media: "video",
    createdBy: "u-m",
    status: "SCHEDULED",
    createdAt: new Date(at(2026, 9, 2, 9)).toISOString(),
    participants: [],
    activeShares: [],
    ...over,
  } as CallDTO;
}

function renderPage(search = "?d=2026-09-02") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/app/meetings/all${search}`]}>
        <Routes>
          <Route path="/app/meetings/all" element={<MeetingsCalendar />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The [from, to) the page last asked the server for, as local timestamps. */
function lastWindow(): { from: number; to: number } {
  const args = api.myCallsInRange.mock.calls.at(-1);
  return { from: new Date(args![0]).getTime(), to: new Date(args![1]).getTime() };
}

describe("MeetingsCalendar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.myCallsInRange.mockResolvedValue([]);
    api.myCalls.mockResolvedValue([]);
    api.myCallHistory.mockResolvedValue({ items: [], nextCursor: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it("asks the server for exactly the week it is showing", async () => {
    renderPage();
    await waitFor(() => expect(api.myCallsInRange).toHaveBeenCalled());
    // 2026-09-02 is a Wednesday; its week runs Monday 31 Aug to Monday 7 Sep.
    expect(lastWindow()).toEqual({ from: at(2026, 8, 31), to: at(2026, 9, 7) });
  });

  // The whole reason the range endpoint exists. myCalls() caps finished
  // meetings at thirty days, so serving the grid from it would make any week
  // older than a month look empty rather than old.
  it("draws the grid from the window read, not from the bounded one", async () => {
    // myCalls() knows nothing about this meeting — it is older than the thirty
    // days that read caps at. The grid must still show it.
    api.myCalls.mockResolvedValue([]);
    api.myCallsInRange.mockResolvedValue([
      call({
        id: "c-old",
        title: "Last quarter's review",
        status: "ENDED",
        scheduledAt: new Date(at(2026, 9, 2, 14)).toISOString(),
        endedAt: new Date(at(2026, 9, 2, 15)).toISOString(),
      }),
    ]);
    renderPage();
    expect(await screen.findByTitle(/Last quarter's review/)).toBeTruthy();
  });

  it("moves the window a week when Next week is pressed", async () => {
    renderPage();
    await waitFor(() => expect(api.myCallsInRange).toHaveBeenCalled());
    screen.getByRole("button", { name: "Next week" }).click();
    await waitFor(() => expect(lastWindow().from).toBe(at(2026, 9, 7)));
    expect(lastWindow().to).toBe(at(2026, 9, 14));
  });

  it("moves it back a week for Previous week", async () => {
    renderPage();
    await waitFor(() => expect(api.myCallsInRange).toHaveBeenCalled());
    screen.getByRole("button", { name: "Previous week" }).click();
    await waitFor(() => expect(lastWindow().from).toBe(at(2026, 8, 24)));
  });

  it("switching to Month asks for whole weeks covering the month", async () => {
    renderPage();
    await waitFor(() => expect(api.myCallsInRange).toHaveBeenCalled());
    screen.getByRole("button", { name: "Month" }).click();
    await waitFor(() => {
      const w = lastWindow();
      // Whole weeks, and September must be inside them.
      expect((w.to - w.from) % (7 * 86_400_000)).toBe(0);
      expect(w.from).toBeLessThanOrEqual(at(2026, 9, 1));
      expect(w.to).toBeGreaterThan(at(2026, 9, 30));
    });
  });

  it("draws a meeting at the clock time it actually starts", async () => {
    api.myCallsInRange.mockResolvedValue([
      call({
        id: "c-grid",
        title: "Design review",
        scheduledAt: new Date(at(2026, 9, 2, 11)).toISOString(),
        endsAt: new Date(at(2026, 9, 2, 12)).toISOString(),
      }),
    ]);
    renderPage();
    const block = await screen.findByTitle(/Design review/);
    expect(block.getAttribute("style")).toContain("top:");
    // 11:00 in a 9→18 window is two ninths down. Asserted as a real number so a
    // block pinned to the top of every column would fail.
    const top = Number(/top:\s*([\d.]+)%/.exec(block.getAttribute("style") ?? "")?.[1]);
    expect(top).toBeCloseTo((2 / 9) * 100, 1);
  });

  it("shows a real error state rather than an empty week when the read fails", async () => {
    api.myCallsInRange.mockRejectedValue(new Error("502"));
    renderPage();
    expect(await screen.findByText("Couldn't load your calendar.")).toBeTruthy();
  });

  // The list under the grid answers a different question and keeps its own
  // sources — it must not be re-pointed at the window.
  it("still reads the list below from the meetings the caller is expected at", async () => {
    renderPage();
    await waitFor(() => expect(api.myCalls).toHaveBeenCalled());
  });

  it("narrows the grid to the kinds the filter names", async () => {
    api.myCallsInRange.mockResolvedValue([
      call({
        id: "c-meeting",
        title: "Design review",
        scheduledAt: new Date(at(2026, 9, 2, 11)).toISOString(),
        endsAt: new Date(at(2026, 9, 2, 12)).toISOString(),
      }),
      call({
        id: "c-channel",
        kind: "CHANNEL",
        title: "Platform sync",
        scheduledAt: new Date(at(2026, 9, 2, 14)).toISOString(),
        endsAt: new Date(at(2026, 9, 2, 15)).toISOString(),
      }),
    ]);
    renderPage();
    await screen.findByTitle(/Design review/);
    expect(screen.getByTitle(/Platform sync/)).toBeTruthy();

    screen.getByRole("button", { name: /Filter/ }).click();
    // Ticking one kind narrows to it — an untouched filter means every kind,
    // so the first click has to SELECT rather than deselect.
    (await screen.findByRole("menuitemcheckbox", { name: "Channel calls" })).click();

    await waitFor(() => expect(screen.queryByTitle(/Design review/)).toBeNull());
    expect(screen.getByTitle(/Platform sync/)).toBeTruthy();
  });

  // Which week is on screen rides in the URL so that opening a meeting and
  // coming back returns to it. The tab strip below shares that string and must
  // not clear it.
  it("keeps the week when the list's tab changes", async () => {
    renderPage();
    await waitFor(() => expect(api.myCallsInRange).toHaveBeenCalled());
    screen.getByRole("button", { name: "Next week" }).click();
    await waitFor(() => expect(lastWindow().from).toBe(at(2026, 9, 7)));

    screen.getByRole("tab", { name: /^Past/ }).click();
    await waitFor(() => expect(api.myCallHistory).toHaveBeenCalled());
    expect(lastWindow().from).toBe(at(2026, 9, 7));
  });
});
