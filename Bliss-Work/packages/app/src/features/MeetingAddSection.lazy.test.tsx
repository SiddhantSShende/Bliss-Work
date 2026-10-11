/**
 * The Add section's lazy loading, end to end through the real dialog, the real paging hook and
 * the real scroll box. Only the network-facing api is stubbed — with the server's own paging
 * semantics (search, then offset/limit over the matches) — so every request the browser makes
 * is visible: how many, with which offset, and when.
 *
 * jsdom does no layout, so the scroll box's geometry is supplied by hand (`scrollTo`): the
 * 288px viewport is real in the browser (h-72) and checked there; what is verified here is
 * what the component does with those numbers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelDTO, UserDTO } from "@taskboard/shared";
import { useSession } from "../store/session";
import { ADA, GENERAL, ME } from "../test/meetingFixtures";
import { channelsPageOf, directoryPageOf, manyChannels, manyUsers, peopleList, channelsList } from "../test/meetingPaging";

const h = vi.hoisted(() => ({
  api: { scheduleMeeting: vi.fn(), createCallInvite: vi.fn(), directoryPage: vi.fn(), channelsPage: vi.fn() },
}));
vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: h.api, config: { webBaseUrl: "https://app.test" } }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { NewMeetingDialog } from "./NewMeetingDialog";

const PAGE = 30; // PICKER_PAGE_SIZE
/** A debounced search (250ms) plus a render, under a loaded CI box. */
const SLOW = { timeout: 4000 };
const ROW_PX = 40;
const VIEWPORT_PX = 288;

function openDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NewMeetingDialog onClose={vi.fn()} onStarted={vi.fn()} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const rowsIn = (box: HTMLElement) => within(box).queryAllByRole("button");
const peopleTab = () => screen.getByRole("tab", { name: /^People/ });

/** Give a list box a geometry, then scroll it to `top` and fire the event a real scroll would. */
function scrollTo(box: HTMLElement, top: number) {
  const rows = rowsIn(box).filter((b) => b.hasAttribute("aria-pressed")).length;
  Object.defineProperty(box, "clientHeight", { configurable: true, value: VIEWPORT_PX });
  Object.defineProperty(box, "scrollHeight", { configurable: true, value: rows * ROW_PX });
  Object.defineProperty(box, "scrollTop", { configurable: true, writable: true, value: top });
  fireEvent.scroll(box);
}
/** The position of the very bottom, for the rows currently loaded. */
const bottom = (box: HTMLElement) =>
  rowsIn(box).filter((b) => b.hasAttribute("aria-pressed")).length * ROW_PX - VIEWPORT_PX;

const offsets = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => (c[0] as { offset: number }).offset);

let members: UserDTO[];
let chans: ChannelDTO[];

beforeEach(() => {
  useSession.setState({ user: ME });
  members = manyUsers(250, ADA);
  chans = manyChannels(130, GENERAL);
  h.api.scheduleMeeting.mockReset().mockResolvedValue({ id: "call-1" });
  h.api.createCallInvite.mockReset().mockResolvedValue({ id: "i", callId: "c", token: "t", expiresAt: "2099-01-01T00:00:00.000Z" });
  h.api.directoryPage.mockReset().mockImplementation(directoryPageOf(members));
  h.api.channelsPage.mockReset().mockImplementation(channelsPageOf(chans));
});

describe("a small list", () => {
  it("is one request, no more are made however far it is scrolled, and nothing says 'loading more'", async () => {
    h.api.directoryPage.mockImplementation(directoryPageOf(members.slice(0, 5)));
    openDialog();
    const box = await screen.findByRole("region", { name: "People" });
    await within(box).findByRole("button", { name: /Member 00001/ });

    scrollTo(box, bottom(box));
    scrollTo(box, bottom(box));

    expect(rowsIn(box)).toHaveLength(5);
    expect(h.api.directoryPage).toHaveBeenCalledTimes(1);
    expect(within(box).queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("a large member list", () => {
  it("loads only the first page on open — never the whole organisation", async () => {
    openDialog();
    const box = await screen.findByRole("region", { name: "People" });
    await within(box).findByRole("button", { name: /Member 00001/ });

    expect(h.api.directoryPage).toHaveBeenCalledTimes(1);
    expect(h.api.directoryPage).toHaveBeenCalledWith({ q: "", offset: 0, limit: PAGE });
    expect(rowsIn(box)).toHaveLength(PAGE);
    expect(screen.queryByRole("button", { name: /Member 00031/ })).not.toBeInTheDocument();
  });

  it("does not fetch while the user is far from the bottom", async () => {
    openDialog();
    const box = await screen.findByRole("region", { name: "People" });
    await within(box).findByRole("button", { name: /Member 00001/ });

    scrollTo(box, 0);
    scrollTo(box, bottom(box) - 400);

    expect(h.api.directoryPage).toHaveBeenCalledTimes(1);
  });

  it("fetches the next page near the bottom, shows a loading indicator while it is in flight, and appends", async () => {
    openDialog();
    const box = await screen.findByRole("region", { name: "People" });
    await within(box).findByRole("button", { name: /Member 00001/ });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = directoryPageOf(members);
    h.api.directoryPage.mockImplementationOnce(async (o: never) => {
      await gate;
      return real(o);
    });
    scrollTo(box, bottom(box) - 20);

    expect(await within(box).findByRole("status")).toHaveTextContent("Loading more…");
    // The first page is still there, untouched, while the next one loads.
    expect(rowsIn(box)).toHaveLength(PAGE);
    await act(async () => release());
    await within(box).findByRole("button", { name: /Member 00060/ });

    expect(offsets(h.api.directoryPage)).toEqual([0, PAGE]);
    expect(rowsIn(box)).toHaveLength(2 * PAGE);
    expect(within(box).getAllByRole("button")[0]).toHaveTextContent("Member 00001"); // appended, not replaced
    expect(within(box).queryByRole("status")).not.toBeInTheDocument();
  });

  it("asks once for a page however fast the scrolling is", async () => {
    openDialog();
    const box = await screen.findByRole("region", { name: "People" });
    await within(box).findByRole("button", { name: /Member 00001/ });
    const real = directoryPageOf(members);
    h.api.directoryPage.mockImplementation(
      (o: never) => new Promise((r) => setTimeout(() => r(real(o)), 30)),
    );

    for (let i = 0; i < 6; i++) scrollTo(box, bottom(box));
    await within(box).findByRole("button", { name: /Member 00060/ });

    expect(offsets(h.api.directoryPage)).toEqual([0, PAGE]);
  });

  it("walks the whole list page by page and then stops asking", async () => {
    openDialog();
    const box = await screen.findByRole("region", { name: "People" });
    await within(box).findByRole("button", { name: /Member 00001/ });

    for (let want = 2 * PAGE; want <= 250; want += PAGE) {
      scrollTo(box, bottom(box));
      await waitFor(() => expect(rowsIn(box).length).toBe(Math.min(want, 250)));
    }
    scrollTo(box, bottom(box));
    scrollTo(box, bottom(box));
    await new Promise((r) => setTimeout(r, 50));

    expect(rowsIn(box)).toHaveLength(250);
    // 250 = 8 full pages + a short one of 10: the short page is the last, so request 9 is the end.
    expect(offsets(h.api.directoryPage)).toEqual([0, 30, 60, 90, 120, 150, 180, 210, 240]);
  });

  it("shows no duplicates when pages overlap", async () => {
    const real = directoryPageOf(members);
    // Every page after the first starts with the last row of the page before it.
    h.api.directoryPage.mockImplementation((o: { offset: number; limit: number; q: string }) =>
      real(o.offset > 0 ? { ...o, offset: o.offset - 1, limit: o.limit } : o),
    );
    openDialog();
    const box = await screen.findByRole("region", { name: "People" });
    await within(box).findByRole("button", { name: /Member 00001/ });

    scrollTo(box, bottom(box));
    await within(box).findByRole("button", { name: /Member 00059/ });

    const names = rowsIn(box).map((b) => b.textContent);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((n) => n?.includes("Member 00030"))).toHaveLength(1);
  });

  it("keeps people picked on earlier pages selected while more load — and sends them all", async () => {
    const user = openDialog();
    const box = await screen.findByRole("region", { name: "People" });
    await user.click(await within(box).findByRole("button", { name: /Member 00003/ }));

    scrollTo(box, bottom(box));
    await user.click(await within(box).findByRole("button", { name: /Member 00045/ }));
    scrollTo(box, bottom(box));
    await user.click(await within(box).findByRole("button", { name: /Member 00075/ }));

    expect(peopleTab()).toHaveTextContent("(3)");
    expect(within(box).getByRole("button", { name: /Member 00003/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("3 members")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Enter meeting title"), "All hands");
    await user.click(screen.getByRole("button", { name: /^(Start|Schedule) Meeting$/ }));
    await waitFor(() => expect(h.api.scheduleMeeting).toHaveBeenCalledTimes(1));
    expect(h.api.scheduleMeeting.mock.calls[0]![0].inviteeIds).toEqual([members[2]!.id, members[44]!.id, members[74]!.id]);
  });

  it("searches the server, debounced: one request for what was typed, paging from zero, selection kept", async () => {
    const user = openDialog();
    const box = await screen.findByRole("region", { name: "People" });
    await user.click(await within(box).findByRole("button", { name: /Member 00002/ }));
    h.api.directoryPage.mockClear();

    await user.type(screen.getByRole("textbox", { name: "Search your organisation" }), "Member 0020");
    await waitFor(() => expect(within(box).queryByRole("button", { name: /Member 00002\b/ })).not.toBeInTheDocument(), SLOW);
    await within(box).findByRole("button", { name: /Member 00200/ }, SLOW);

    // Eleven keystrokes, one request, and it is for the whole term.
    expect(h.api.directoryPage).toHaveBeenCalledTimes(1);
    expect(h.api.directoryPage).toHaveBeenCalledWith({ q: "Member 0020", offset: 0, limit: PAGE });
    expect(rowsIn(box)).toHaveLength(10); // Member 00200 … Member 00209

    // The person picked before searching is still picked, and still named.
    expect(peopleTab()).toHaveTextContent("(1)");
    expect(screen.getByText("1 member")).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Search your organisation" }));
    expect(await within(box).findByRole("button", { name: /Member 00002\b/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("pages a search too, and the results of an earlier search never mix into a later one", async () => {
    const user = openDialog();
    await screen.findByRole("region", { name: "People" });
    const search = screen.getByRole("textbox", { name: "Search your organisation" });

    await user.type(search, "Member 00");
    const box = peopleList();
    // The debounced search has gone out and its first page has replaced the unfiltered one.
    await waitFor(() =>
      expect(h.api.directoryPage).toHaveBeenCalledWith({ q: "Member 00", offset: 0, limit: PAGE }),
      SLOW,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => expect(rowsIn(box)).toHaveLength(PAGE));
    scrollTo(box, bottom(box));
    await waitFor(() => expect(rowsIn(box)).toHaveLength(2 * PAGE));
    expect(h.api.directoryPage).toHaveBeenLastCalledWith({ q: "Member 00", offset: PAGE, limit: PAGE });

    await user.clear(search);
    await user.type(search, "Member 00249");
    await waitFor(() => expect(rowsIn(box)).toHaveLength(1), SLOW);
    expect(rowsIn(box)[0]).toHaveTextContent("Member 00249");
  });
});

describe("a large channel list", () => {
  async function openChannels() {
    const user = openDialog();
    await user.click(screen.getByRole("tab", { name: /^Channels/ }));
    const box = await screen.findByRole("region", { name: "Channels" });
    await within(box).findByRole("button", { name: /chan-00001/ });
    return { user, box };
  }

  it("loads one page on opening the tab, and nothing for the tab that was never opened", async () => {
    const { box } = await openChannels();

    expect(h.api.channelsPage).toHaveBeenCalledTimes(1);
    expect(h.api.channelsPage).toHaveBeenCalledWith({ q: "", offset: 0, limit: PAGE });
    expect(rowsIn(box)).toHaveLength(PAGE);
  });

  it("appends the next pages near the bottom and stops at the end", async () => {
    const { box } = await openChannels();

    for (let want = 2 * PAGE; want <= 130; want += PAGE) {
      scrollTo(box, bottom(box));
      await waitFor(() => expect(rowsIn(box).length).toBe(Math.min(want, 130)));
    }
    scrollTo(box, bottom(box));
    await new Promise((r) => setTimeout(r, 50));

    expect(rowsIn(box)).toHaveLength(130);
    expect(offsets(h.api.channelsPage)).toEqual([0, 30, 60, 90, 120]);
  });

  it("keeps channels picked on earlier pages selected, and sends them", async () => {
    const { user, box } = await openChannels();
    await user.click(within(box).getByRole("button", { name: /chan-00004/ }));
    scrollTo(box, bottom(box));
    await user.click(await within(box).findByRole("button", { name: /chan-00050/ }));

    expect(screen.getByRole("tab", { name: /^Channels/ })).toHaveTextContent("(2)");
    await user.type(screen.getByPlaceholderText("Enter meeting title"), "Sync");
    await user.click(screen.getByRole("button", { name: /^(Start|Schedule) Meeting$/ }));
    await waitFor(() => expect(h.api.scheduleMeeting).toHaveBeenCalledTimes(1));
    expect(h.api.scheduleMeeting.mock.calls[0]![0].channelIds).toEqual([chans[3]!.id, chans[49]!.id]);
  });

  it("searches the server, debounced", async () => {
    const { user, box } = await openChannels();
    h.api.channelsPage.mockClear();

    await user.type(screen.getByRole("textbox", { name: "Search your channels" }), "chan-0012");
    await within(box).findByRole("button", { name: /chan-00120/ }, SLOW);
    await waitFor(() => expect(rowsIn(box)).toHaveLength(10), SLOW);

    expect(h.api.channelsPage).toHaveBeenCalledTimes(1);
    expect(h.api.channelsPage).toHaveBeenCalledWith({ q: "chan-0012", offset: 0, limit: PAGE });
  });
});

describe("a small channel list", () => {
  it("is one request and no more", async () => {
    h.api.channelsPage.mockImplementation(channelsPageOf(chans.slice(0, 4)));
    const user = openDialog();
    await user.click(screen.getByRole("tab", { name: /^Channels/ }));
    await within(channelsList()).findByRole("button", { name: /chan-00001/ });
    scrollTo(channelsList(), 0);
    scrollTo(channelsList(), 1000);

    expect(h.api.channelsPage).toHaveBeenCalledTimes(1);
    expect(rowsIn(channelsList())).toHaveLength(4);
  });
});
