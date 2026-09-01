/**
 * The bucket column — Meetings' answer to Mail's Inbox / Sent / Drafts.
 *
 * The thing worth testing here is not that three links render. It is that the
 * chosen bucket goes into the URL rather than into component state: the list
 * and this column are rendered by different parts of the tree (this one by the
 * app shell, the list by MeetingsLayout), and the only reason they agree about
 * which bucket is open is that both read it from the search string.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CallDTO } from "@taskboard/shared";

const api = { myCalls: vi.fn() };
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));
vi.mock("../lib/callWindow", () => ({ openCallTab: vi.fn() }));
vi.mock("../lib/MeetingSession", () => ({
  useMeetingSession: () => ({ enter: vi.fn(), restore: vi.fn(), call: null }),
}));
vi.mock("../features/NewMeetingDialog", () => ({ NewMeetingDialog: () => null }));

import { MeetingFolders } from "./MeetingFolders";

function call(over: Partial<CallDTO> = {}): CallDTO {
  return {
    id: "c-1",
    orgId: "org-1",
    kind: "MEETING",
    title: "x",
    media: "video",
    createdBy: "u-me",
    status: "ENDED",
    createdAt: "2026-08-01T09:00:00.000Z",
    participants: [],
    activeShares: [],
    ...over,
  } as CallDTO;
}

function renderFolders(entry = "/app/meetings/all") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <MeetingFolders />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MeetingFolders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.myCalls.mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("offers exactly the three buckets", async () => {
    renderFolders();
    expect(await screen.findByRole("link", { name: /Upcoming/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Live/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Past/ })).toBeTruthy();
  });

  it("puts the chosen bucket in the URL — the list reads it from there", async () => {
    renderFolders();
    const past = await screen.findByRole("link", { name: /Past/ });
    expect(past.getAttribute("href")).toBe("/app/meetings/all?view=past");
    // Upcoming is the default and stays OUT of the URL, so the tidy link is the
    // common one.
    expect(screen.getByRole("link", { name: /Upcoming/ }).getAttribute("href")).toBe(
      "/app/meetings/all",
    );
  });

  it("marks the open bucket as the current page", async () => {
    renderFolders("/app/meetings/all?view=live");
    const live = await screen.findByRole("link", { name: /Live/ });
    expect(live.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /Upcoming/ }).getAttribute("aria-current")).toBeNull();
  });

  it("counts what is on the calendar, from the SAME request the list reads", async () => {
    api.myCalls.mockResolvedValue([
      call({ id: "a", status: "SCHEDULED", scheduledAt: "2026-09-01T09:00:00.000Z" }),
      call({ id: "b", status: "SCHEDULED", scheduledAt: "2026-09-02T09:00:00.000Z" }),
      call({ id: "c", status: "LIVE", startedAt: "2026-09-01T08:00:00.000Z" }),
    ]);
    renderFolders();
    // The count rides in the accessible name so a screen reader hears what the
    // number counts, not a bare "2".
    expect(await screen.findByRole("link", { name: "Upcoming, 2 meetings" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Live, 1 meetings" })).toBeTruthy();
  });

  it("prints NO number on Past — it is an endless paged list, and any number here would be a lie", async () => {
    api.myCalls.mockResolvedValue([call({ id: "z", status: "ENDED" })]);
    renderFolders();
    await screen.findByRole("link", { name: /Upcoming/ });
    // The Past link's accessible name is the bare label: no count was added.
    expect(screen.getByRole("link", { name: "Past" })).toBeTruthy();
  });
});
