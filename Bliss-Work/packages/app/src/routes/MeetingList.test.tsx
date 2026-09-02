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

function renderList(search = "", onOpenRoom?: (call: CallDTO) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/app/meetings/all${search}`]}>
        <Routes>
          <Route path="/app/meetings/all" element={<MeetingList onOpenRoom={onOpenRoom} />} />
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

  // ── What a row actually says ───────────────────────────────────────────────
  // The row is the section's answer to "which meeting is this, when, whose, and
  // what can I do about it". Each of those is a separate promise and each one
  // has broken independently before, so they are asserted separately rather
  // than as one snapshot.

  it("prints the clock times a meeting actually ran between", async () => {
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
    await screen.findByText("Retro");
    // Local time, so the assertion is built the same way the row is rather than
    // being pinned to a timezone the test machine may not be in.
    const from = new Date("2026-01-02T09:00:00.000Z").toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    const to = new Date("2026-01-02T10:30:00.000Z").toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(screen.getByText(new RegExp(`${from}\\s*–\\s*${to}`))).toBeTruthy();
  });

  it("names the organiser and counts the people on the roster", async () => {
    api.myCalls.mockResolvedValue([
      call({
        id: "c-org",
        title: "Planning",
        status: "SCHEDULED",
        scheduledAt: "2026-09-01T09:00:00.000Z",
        createdBy: "u-m",
        participants: [person("u-m"), person("u-s"), person("u-a", false)],
      }),
    ]);
    renderList();
    await screen.findByText("Planning");
    expect(screen.getByText("Mayank")).toBeTruthy();
    // The ROSTER, not the turnout — "who is expected" is what an upcoming row
    // is about, and the title carries the split for anyone who wants it.
    expect(screen.getByTitle("3 invited · 2 joined")).toBeTruthy();
  });

  it("offers Join on a live meeting and hands the caller the call to open", async () => {
    const onOpenRoom = vi.fn();
    api.myCalls.mockResolvedValue([
      call({ id: "c-live", title: "Standup", status: "LIVE", startedAt: new Date().toISOString() }),
    ]);
    renderList("?view=live", onOpenRoom);
    const join = await screen.findByRole("button", { name: "Join" });
    join.click();
    expect(onOpenRoom).toHaveBeenCalledTimes(1);
    expect(onOpenRoom.mock.calls[0]?.[0]?.id).toBe("c-live");
  });

  // The one rule Past must never break: there is nothing left to join, so
  // offering a button that says otherwise would be the row lying about the
  // meeting's state.
  it("never offers Join on a meeting that has already ended", async () => {
    api.myCallHistory.mockResolvedValue({
      items: [
        call({
          id: "c-old",
          title: "Retro",
          status: "ENDED",
          startedAt: "2026-01-02T09:00:00.000Z",
          endedAt: "2026-01-02T10:00:00.000Z",
        }),
      ],
      nextCursor: null,
    });
    renderList("?view=past", vi.fn());
    await screen.findByText("Retro");
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
  });

  it("switches bucket through the URL, so the tab survives opening a meeting", async () => {
    api.myCalls.mockResolvedValue([
      call({ id: "c-up", title: "Planning", status: "SCHEDULED", scheduledAt: "2026-09-01T09:00:00.000Z" }),
      call({ id: "c-live", title: "Standup", status: "LIVE", startedAt: new Date().toISOString() }),
    ]);
    renderList();
    await screen.findByText("Planning");
    screen.getByRole("tab", { name: /^Live/ }).click();
    expect(await screen.findByText("Standup")).toBeTruthy();
    expect(screen.queryByText("Planning")).toBeNull();
  });

  it("marks a live meeting as live", async () => {
    api.myCalls.mockResolvedValue([
      call({ id: "c-live", title: "Standup", status: "LIVE", startedAt: new Date().toISOString() }),
    ]);
    renderList("?view=live");
    expect(await screen.findByText("Live")).toBeTruthy();
  });

  it("asks the server for 5 at a time", async () => {
    api.myCallHistory.mockResolvedValue({
      items: [call({ id: "c-old", title: "Retro", status: "ENDED", startedAt: "2026-01-02T09:00:00.000Z", endedAt: "2026-01-02T10:00:00.000Z" })],
      nextCursor: "cursor-1",
    });
    renderList("?view=past");
    await screen.findByText("Retro");
    expect(api.myCallHistory).toHaveBeenCalledWith(undefined, 5);
  });

  it("offers Load more while there is another page, and fetches the next 5 on click", async () => {
    api.myCallHistory.mockResolvedValueOnce({
      items: [call({ id: "c-1", title: "Retro", status: "ENDED", startedAt: "2026-01-02T09:00:00.000Z", endedAt: "2026-01-02T10:00:00.000Z" })],
      nextCursor: "cursor-1",
    });
    renderList("?view=past");
    await screen.findByText("Retro");

    api.myCallHistory.mockResolvedValueOnce({
      items: [call({ id: "c-2", title: "Kickoff", status: "ENDED", startedAt: "2026-01-01T09:00:00.000Z", endedAt: "2026-01-01T10:00:00.000Z" })],
      nextCursor: null,
    });
    screen.getByRole("button", { name: "Load more" }).click();

    await waitFor(() => expect(api.myCallHistory).toHaveBeenCalledWith("cursor-1", 5));
    expect(await screen.findByText("Kickoff")).toBeTruthy();
    // Both pages stay on screen — Load more accumulates, it doesn't replace.
    expect(screen.getByText("Retro")).toBeTruthy();
  });

  it("says so once every page has been loaded, instead of offering Load more forever", async () => {
    api.myCallHistory.mockResolvedValue({
      items: [call({ id: "c-old", title: "Retro", status: "ENDED", startedAt: "2026-01-02T09:00:00.000Z", endedAt: "2026-01-02T10:00:00.000Z" })],
      nextCursor: null,
    });
    renderList("?view=past");
    expect(await screen.findByText("That's everything.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});
