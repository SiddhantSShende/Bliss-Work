/**
 * The meeting list: which bucket it shows, where each bucket's rows come from,
 * and what a row says about a meeting.
 *
 * Two of these carry over from the page this replaced. myCalls() returns
 * z.array(CallDTO), which fails its ENTIRE parse if even one row is malformed —
 * so one bad row used to empty the whole list into "Nothing scheduled", and a
 * real fact about an empty calendar must never read the same way as a failed
 * request.
 *
 * The rest are new, and the important one is the source split: Past does NOT
 * read myCalls(). That endpoint caps its history at a month, which is exactly
 * what made the old Past tab quietly stop a month back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CallDTO } from "@taskboard/shared";

const api = { myCalls: vi.fn(), myCallHistory: vi.fn() };
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: unknown) => unknown) => sel({ user: { id: "u-me", orgId: "org-1" } }),
}));
vi.mock("../lib/userLabel", () => ({
  useUserLabels: () => ({
    nameOf: (id: string) => ({ "u-m": "Mayank", "u-s": "Siddhant", "u-a": "Ada" })[id] ?? id,
    avatarUrlOf: () => null,
  }),
}));

import { MeetingList } from "./MeetingList";

function person(userId: string, joined = true) {
  return {
    userId,
    orgId: "org-1",
    role: "PARTICIPANT" as const,
    username: userId,
    joinedAt: joined ? "2026-08-01T09:00:00.000Z" : null,
    leftAt: null,
    waitingSince: null,
    external: false,
  };
}

function call(over: Partial<CallDTO> = {}): CallDTO {
  return {
    id: "c-1",
    orgId: "org-1",
    kind: "MEETING",
    title: "",
    media: "video",
    createdBy: "u-me",
    status: "ENDED",
    createdAt: "2026-08-01T09:00:00.000Z",
    participants: [],
    activeShares: [],
    ...over,
  } as CallDTO;
}

function renderList(search = "") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/app/meetings/all${search}`]}>
        <Routes>
          <Route path="/app/meetings/all" element={<MeetingList />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MeetingList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.myCalls.mockResolvedValue([]);
    api.myCallHistory.mockResolvedValue({ items: [], nextCursor: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows a genuine error state, not an empty calendar, when the request fails", async () => {
    api.myCalls.mockRejectedValue(new Error("502"));
    renderList();
    expect(await screen.findByText("Couldn't load your meetings.")).toBeTruthy();
    expect(screen.queryByText("Nothing scheduled")).toBeNull();
  });

  it("still shows the real empty state on a genuinely empty response", async () => {
    renderList();
    expect(await screen.findByText("Nothing scheduled")).toBeTruthy();
  });

  it("retry re-issues the request", async () => {
    api.myCalls.mockRejectedValueOnce(new Error("502")).mockResolvedValueOnce([]);
    renderList();
    await screen.findByText("Couldn't load your meetings.");
    screen.getByRole("button", { name: "Retry" }).click();
    await waitFor(() => expect(api.myCalls).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Nothing scheduled")).toBeTruthy();
  });

  it("shows only SCHEDULED meetings in Upcoming", async () => {
    api.myCalls.mockResolvedValue([
      call({ id: "c-up", title: "Planning", status: "SCHEDULED", scheduledAt: "2026-09-01T09:00:00.000Z" }),
      call({ id: "c-live", title: "Standup", status: "LIVE", startedAt: "2026-09-01T08:00:00.000Z" }),
    ]);
    renderList();
    expect(await screen.findByText("Planning")).toBeTruthy();
    expect(screen.queryByText("Standup")).toBeNull();
  });

  it("shows only LIVE meetings in Live", async () => {
    api.myCalls.mockResolvedValue([
      call({ id: "c-up", title: "Planning", status: "SCHEDULED", scheduledAt: "2026-09-01T09:00:00.000Z" }),
      call({ id: "c-live", title: "Standup", status: "LIVE", startedAt: "2026-09-01T08:00:00.000Z" }),
    ]);
    renderList("?view=live");
    expect(await screen.findByText("Standup")).toBeTruthy();
    expect(screen.queryByText("Planning")).toBeNull();
  });

  it("reads PAST from the paged history endpoint, never from myCalls — that one caps at a month", async () => {
    api.myCallHistory.mockResolvedValue({
      items: [call({ id: "c-old", title: "Retro", status: "ENDED", startedAt: "2026-01-02T09:00:00.000Z", endedAt: "2026-01-02T10:00:00.000Z" })],
      nextCursor: null,
    });
    renderList("?view=past");
    expect(await screen.findByText("Retro")).toBeTruthy();
    await waitFor(() => expect(api.myCallHistory).toHaveBeenCalled());
  });

  it("does NOT fetch anybody's history just because they glanced at their calendar", async () => {
    renderList();
    await screen.findByText("Nothing scheduled");
    expect(api.myCallHistory).not.toHaveBeenCalled();
  });

  it("names an untitled meeting after the people who were in it", async () => {
    api.myCallHistory.mockResolvedValue({
      items: [
        call({
          id: "c-untitled",
          title: "",
          status: "ENDED",
          startedAt: "2026-01-02T09:00:00.000Z",
          endedAt: "2026-01-02T10:00:00.000Z",
          participants: [person("u-m"), person("u-s"), person("u-me")],
        }),
      ],
      nextCursor: null,
    });
    renderList("?view=past");
    expect(await screen.findByText("Mayank & Siddhant")).toBeTruthy();
  });

  it("says how long a finished meeting ran", async () => {
    api.myCallHistory.mockResolvedValue({
      items: [
        call({
          id: "c-dur",
          title: "Retro",
          status: "ENDED",
          startedAt: "2026-01-02T09:00:00.000Z",
          endedAt: "2026-01-02T10:30:00.000Z",
        }),
      ],
      nextCursor: null,
    });
    renderList("?view=past");
    expect(await screen.findByText("1h 30m")).toBeTruthy();
  });

  it("marks a live meeting as live", async () => {
    api.myCalls.mockResolvedValue([
      call({ id: "c-live", title: "Standup", status: "LIVE", startedAt: new Date().toISOString() }),
    ]);
    renderList("?view=live");
    expect(await screen.findByText("Live")).toBeTruthy();
  });
});
