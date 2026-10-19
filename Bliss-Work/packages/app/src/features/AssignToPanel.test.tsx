/**
 * The "Assign to" panel: People / Channels tabs, a search per tab, and a server-paged,
 * scroll-loaded list of checkboxes. Selection belongs to the caller, so the wrapper
 * below holds it exactly as CreateTaskDialog does.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { ChannelDTO, ProjectDTO, UserDTO } from "@taskboard/shared";
import { useSession } from "../store/session";
import { ME } from "../test/meetingFixtures";
import { makeChannels, makeUsers, pagedChannels, pagedDirectory, scrollToEnd, stubScrollGeometry } from "../test/pagedPickerApi";

const h = vi.hoisted(() => ({ api: { directoryPage: vi.fn(), channelsPage: vi.fn(), projects: vi.fn() } }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));

import { AssignToPanel, type ChannelPickLike } from "./AssignToPanel";
import { PICKER_PAGE_SIZE } from "../lib/usePagedPicker";

const PAGE = PICKER_PAGE_SIZE; // 30
let restoreGeometry: () => void;
let onPeople: Mock<(u: UserDTO) => void>;
let onChannels: Mock<(c: ChannelPickLike) => void>;
let onProjects: Mock<(p: ProjectDTO) => void>;

function Harness({
  initialTab = "people",
  projectDerivedChannels = [],
}: {
  initialTab?: "projects" | "people" | "channels";
  projectDerivedChannels?: ChannelPickLike[];
}) {
  const [people, setPeople] = useState<Set<string>>(new Set());
  const [channels, setChannels] = useState<Set<string>>(new Set(projectDerivedChannels.map((c) => c.id)));
  const [projects, setProjects] = useState<Set<string>>(new Set());
  return (
    <AssignToPanel
      people={people}
      channels={channels}
      projects={projects}
      projectDerivedChannels={projectDerivedChannels}
      initialTab={initialTab}
      onTogglePerson={(u: UserDTO) => {
        onPeople(u);
        setPeople((s) => { const n = new Set(s); if (!n.delete(u.id)) n.add(u.id); return n; });
      }}
      onToggleChannel={(c: ChannelPickLike) => {
        onChannels(c);
        setChannels((s) => { const n = new Set(s); if (!n.delete(c.id)) n.add(c.id); return n; });
      }}
      onToggleProject={(p: ProjectDTO) => {
        onProjects(p);
        setProjects((s) => { const n = new Set(s); if (!n.delete(p.id)) n.add(p.id); return n; });
      }}
    />
  );
}

function mount(initialTab: "projects" | "people" | "channels" = "people", projectDerivedChannels: ChannelPickLike[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Harness initialTab={initialTab} projectDerivedChannels={projectDerivedChannels} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const scroller = (name: RegExp | string) => screen.getByLabelText(name) as HTMLElement;
const peopleBox = () => scroller("People to assign to");
const channelsBox = () => scroller("Channels to assign to");
const projectsBox = () => scroller("Projects to assign to");
const rows = (box: HTMLElement) => within(box).queryAllByRole("checkbox");
const scroll = (box: HTMLElement) => scrollToEnd(box, (el) => fireEvent.scroll(el));

beforeEach(() => {
  restoreGeometry = stubScrollGeometry();
  useSession.setState({ user: ME });
  onPeople = vi.fn<(u: UserDTO) => void>();
  onChannels = vi.fn<(c: ChannelPickLike) => void>();
  onProjects = vi.fn<(p: ProjectDTO) => void>();
  h.api.directoryPage.mockReset().mockImplementation(pagedDirectory(makeUsers(100)));
  h.api.channelsPage.mockReset().mockImplementation(pagedChannels(makeChannels(75)));
  h.api.projects.mockReset().mockResolvedValue([]);
});
afterEach(() => restoreGeometry());

describe("opening", () => {
  it("puts Projects before Channels before People, and opens the channel list first in the task dialog", async () => {
    mount("channels");
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveAccessibleName(/^Projects/);
    expect(tabs[1]).toHaveAccessibleName(/^Channels/);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[2]).toHaveAccessibleName(/^People/);
    await waitFor(() => expect(rows(channelsBox())).toHaveLength(PAGE));
  });

  it("shows People selected, every count at 0, and the search directly under the tabs", async () => {
    mount();
    expect(screen.getByRole("tab", { name: /People \(0\)/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Channels \(0\)/ })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: /Projects \(0\)/ })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("group", { name: /Assign to/ })).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search people in your organisation" });
    expect(screen.getByRole("tablist").compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(PAGE));
  });

  it("does not ask for projects until the Projects tab is opened", async () => {
    const user = mount();
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(PAGE));
    expect(h.api.projects).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: /Projects/ }));
    await waitFor(() => expect(h.api.projects).toHaveBeenCalledTimes(1));
  });

  it("loads ONE page of a 100-person organisation, not all of it", async () => {
    mount();
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(PAGE));
    expect(h.api.directoryPage).toHaveBeenCalledTimes(1);
    expect(h.api.directoryPage).toHaveBeenCalledWith({ q: "", offset: 0, limit: PAGE });
  });

  it("does not ask for channels until the Channels tab is opened", async () => {
    const user = mount();
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(PAGE));
    expect(h.api.channelsPage).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: /Channels/ }));
    await waitFor(() => expect(rows(channelsBox())).toHaveLength(PAGE));
    expect(h.api.channelsPage).toHaveBeenCalledTimes(1);
  });

  it("gives the list a bounded scroll box from the start, whatever the organisation's size", async () => {
    mount();
    const box = peopleBox();
    // The scroller is absolutely positioned inside a flex-1 / min-h box, so its rows
    // cannot make the box (or the dialog) taller.
    expect(box).toHaveClass("absolute", "inset-0", "overflow-y-auto");
    expect(box.parentElement).toHaveClass("relative", "min-h-0", "flex-1");
    expect(box.parentElement!.parentElement).toHaveClass("min-h-[20rem]", "flex-1", "overflow-hidden");
    await waitFor(() => expect(rows(box)).toHaveLength(PAGE));
  });
});

describe("lazy loading", () => {
  it("appends the next page when scrolled near the bottom, then stops at the end", async () => {
    mount();
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(PAGE));
    expect(screen.getByText("Person 000")).toBeInTheDocument();

    scroll(peopleBox());
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(2 * PAGE));
    expect(h.api.directoryPage).toHaveBeenLastCalledWith({ q: "", offset: PAGE, limit: PAGE });
    expect(screen.getByText("Person 000")).toBeInTheDocument(); // the first page is still there

    scroll(peopleBox());
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(3 * PAGE));
    scroll(peopleBox());
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(100)); // the 10-row last page
    const calls = h.api.directoryPage.mock.calls.length;

    scroll(peopleBox());
    scroll(peopleBox());
    await new Promise((r) => setTimeout(r, 50));
    expect(h.api.directoryPage).toHaveBeenCalledTimes(calls); // a short page was the end: no more requests
    expect(rows(peopleBox())).toHaveLength(100);
  });

  it("does not load a page the user has not scrolled toward", async () => {
    mount();
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(PAGE));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.api.directoryPage).toHaveBeenCalledTimes(1);
  });

  it("shows 'Loading more people…' while the next page is in flight, then removes it", async () => {
    mount();
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(PAGE));
    let release!: () => void;
    const real = pagedDirectory(makeUsers(100));
    h.api.directoryPage.mockImplementationOnce(async (a: never) => {
      await new Promise<void>((r) => (release = r));
      return real(a);
    });
    scroll(peopleBox());
    expect(await screen.findByText("Loading more people…")).toBeInTheDocument();
    expect(peopleBox()).toHaveAttribute("aria-busy", "true");
    await act(async () => release());
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(2 * PAGE));
    expect(screen.queryByText("Loading more people…")).not.toBeInTheDocument();
  });

  it("makes ONE request however fast it is scrolled while a page is loading", async () => {
    mount();
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(PAGE));
    let release!: () => void;
    const real = pagedDirectory(makeUsers(100));
    h.api.directoryPage.mockImplementationOnce(async (a: never) => {
      await new Promise<void>((r) => (release = r));
      return real(a);
    });
    const before = h.api.directoryPage.mock.calls.length;
    for (let i = 0; i < 40; i++) scroll(peopleBox()); // a flung scroll wheel
    await new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 40; i++) scroll(peopleBox());
    expect(h.api.directoryPage.mock.calls.length - before).toBe(1);
    await act(async () => release());
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(2 * PAGE));
    expect(h.api.directoryPage.mock.calls.length - before).toBe(1);
  });

  it("never shows the same person twice when pages overlap", async () => {
    const all = makeUsers(100);
    // A member was added mid-scroll, so page two starts five rows early.
    h.api.directoryPage.mockReset().mockImplementation(async ({ offset = 0, limit = PAGE }: { offset?: number; limit?: number }) =>
      all.slice(offset === 0 ? 0 : offset - 5, (offset === 0 ? 0 : offset - 5) + limit));
    mount();
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(PAGE));
    scroll(peopleBox());
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(2 * PAGE - 5));
    const names = rows(peopleBox()).map((r) => r.closest("label")!.textContent);
    expect(new Set(names).size).toBe(names.length);
  });

  it("treats a server that ignores `limit` as complete, rather than paging forever", async () => {
    h.api.directoryPage.mockReset().mockResolvedValue(makeUsers(45)); // everything, every time
    mount();
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(45));
    scroll(peopleBox());
    await new Promise((r) => setTimeout(r, 50));
    expect(h.api.directoryPage).toHaveBeenCalledTimes(1);
  });

  it("keeps loading by itself while the rows do not yet fill the box", async () => {
    // 5 rows × 40px = 200px in a 300px window: nothing to scroll, so nothing would ever ask for more.
    h.api.directoryPage.mockReset().mockImplementation(pagedDirectory(makeUsers(12)));
    mount();
    const box = peopleBox();
    await waitFor(() => expect(rows(box)).toHaveLength(12));
    expect(h.api.directoryPage).toHaveBeenCalledTimes(1); // 12 < a page: complete
  });
});

describe("search", () => {
  it("asks the server once, for what was typed, after typing stops — and starts again from the first page", async () => {
    const user = mount();
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(PAGE));
    scroll(peopleBox());
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(2 * PAGE));
    h.api.directoryPage.mockClear();

    await user.type(screen.getByRole("searchbox", { name: "Search people in your organisation" }), "person07");
    await waitFor(() => expect(h.api.directoryPage).toHaveBeenCalledTimes(1));
    expect(h.api.directoryPage).toHaveBeenCalledWith({ q: "person07", offset: 0, limit: PAGE });
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(10)); // person070 … person079
    expect(screen.queryByText("Person 000")).not.toBeInTheDocument();
  });

  it("pages a search: its second page continues the SEARCH, not the directory", async () => {
    const user = mount();
    // "person" matches all 100; "n0" matches person000-099 (n0 occurs in every "person0xx"): use a 45-hit query instead.
    h.api.directoryPage.mockReset().mockImplementation(pagedDirectory(makeUsers(100)));
    await user.type(screen.getByRole("searchbox", { name: "Search people in your organisation" }), "person0");
    await waitFor(() => expect(h.api.directoryPage).toHaveBeenCalledWith({ q: "person0", offset: 0, limit: PAGE }));
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(PAGE));
    scroll(peopleBox());
    await waitFor(() => expect(h.api.directoryPage).toHaveBeenCalledWith({ q: "person0", offset: PAGE, limit: PAGE }));
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(2 * PAGE));
  });

  it("filters what comes back too, so a server that ignores `q` still shows only matches", async () => {
    h.api.directoryPage.mockReset().mockImplementation(async ({ offset = 0, limit = PAGE }: { offset?: number; limit?: number }) => makeUsers(100).slice(offset, offset + limit));
    const user = mount();
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(PAGE));
    await user.type(screen.getByRole("searchbox", { name: "Search people in your organisation" }), "person012");
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(1));
    expect(within(peopleBox()).getByText("Person 012")).toBeInTheDocument();
  });

  it("says so when nothing matches", async () => {
    const user = mount();
    await user.type(screen.getByRole("searchbox", { name: "Search people in your organisation" }), "zzzz");
    expect(await screen.findByText("No people match your search.")).toBeInTheDocument();
  });

  it("keeps each tab's own search text when switching", async () => {
    const user = mount();
    await user.type(screen.getByRole("searchbox"), "person05");
    await user.click(screen.getByRole("tab", { name: /Channels/ }));
    expect(screen.getByRole("searchbox", { name: "Search your channels" })).toHaveValue("");
    await user.type(screen.getByRole("searchbox"), "team-02");
    await user.click(screen.getByRole("tab", { name: /People/ }));
    expect(screen.getByRole("searchbox", { name: "Search people in your organisation" })).toHaveValue("person05");
    await user.click(screen.getByRole("tab", { name: /Channels/ }));
    expect(screen.getByRole("searchbox", { name: "Search your channels" })).toHaveValue("team-02");
  });

  it("Enter in the search box does not submit the task form around it", async () => {
    const submit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const qc = new QueryClient();
    render(<QueryClientProvider client={qc}><form onSubmit={submit}><Harness /></form></QueryClientProvider>);
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox"), "abc{Enter}");
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("selection", () => {
  it("clicking anywhere on the row toggles it, and the tab count follows", async () => {
    const user = mount();
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(PAGE));
    await user.click(within(peopleBox()).getByText("Person 003")); // the name, not the checkbox
    expect(onPeople).toHaveBeenCalledTimes(1);
    expect(onPeople.mock.calls[0]![0]).toMatchObject({ username: "person003" });
    expect(screen.getByRole("tab", { name: /People \(1\)/ })).toBeInTheDocument();
    expect(within(peopleBox()).getByRole("checkbox", { name: /Person 003/ })).toBeChecked();
    await user.click(within(peopleBox()).getByRole("checkbox", { name: /Person 003/ }));
    expect(screen.getByRole("tab", { name: /People \(0\)/ })).toBeInTheDocument();
  });

  it("a selection made on page one is still checked after page two loads", async () => {
    const user = mount();
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(PAGE));
    await user.click(within(peopleBox()).getByRole("checkbox", { name: /Person 001/ }));
    scroll(peopleBox());
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(2 * PAGE));
    await user.click(within(peopleBox()).getByRole("checkbox", { name: /Person 040/ }));
    expect(within(peopleBox()).getByRole("checkbox", { name: /Person 001/ })).toBeChecked();
    expect(screen.getByRole("tab", { name: /People \(2\)/ })).toBeInTheDocument();
  });

  it("a pick survives a search that no longer shows it — and is checked again when it returns", async () => {
    const user = mount();
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(PAGE));
    await user.click(within(peopleBox()).getByRole("checkbox", { name: /Person 001/ }));
    const box = screen.getByRole("searchbox", { name: "Search people in your organisation" });
    await user.type(box, "person09");
    await waitFor(() => expect(within(peopleBox()).queryByText("Person 001")).not.toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /People \(1\)/ })).toBeInTheDocument(); // counted though off-screen
    await user.clear(box);
    await waitFor(() => expect(within(peopleBox()).getByRole("checkbox", { name: /Person 001/ })).toBeChecked());
  });

  it("People and Channels picks both survive switching tabs", async () => {
    const user = mount();
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(PAGE));
    await user.click(within(peopleBox()).getByRole("checkbox", { name: /Person 002/ }));
    await user.click(screen.getByRole("tab", { name: /Channels/ }));
    await waitFor(() => expect(rows(channelsBox())).toHaveLength(PAGE));
    await user.click(within(channelsBox()).getByRole("checkbox", { name: /team-004/ }));
    await user.click(screen.getByRole("tab", { name: /People/ }));
    await user.click(screen.getByRole("tab", { name: /Channels/ }));

    expect(screen.getByRole("tab", { name: /People \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Channels \(1\)/ })).toBeInTheDocument();
    expect(within(channelsBox()).getByRole("checkbox", { name: /team-004/ })).toBeChecked();
    await user.click(screen.getByRole("tab", { name: /People/ }));
    expect(within(peopleBox()).getByRole("checkbox", { name: /Person 002/ })).toBeChecked();
  });

  it("a tab keeps its loaded pages when you leave it and come back — no refetch, no reset", async () => {
    const user = mount();
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(PAGE));
    scroll(peopleBox());
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(2 * PAGE));
    const calls = h.api.directoryPage.mock.calls.length;
    await user.click(screen.getByRole("tab", { name: /Channels/ }));
    await user.click(screen.getByRole("tab", { name: /People/ }));
    expect(rows(peopleBox())).toHaveLength(2 * PAGE);
    expect(h.api.directoryPage.mock.calls.length).toBe(calls);
  });

  it("marks the caller (You)", async () => {
    h.api.directoryPage.mockReset().mockImplementation(pagedDirectory([ME, ...makeUsers(3)]));
    mount();
    expect(await within(peopleBox()).findByText("(You)")).toBeInTheDocument();
  });
});

describe("channels", () => {
  it("pages, searches, shows member counts and a lock, and reports the whole channel when picked", async () => {
    const user = mount();
    await user.click(screen.getByRole("tab", { name: /Channels/ }));
    await waitFor(() => expect(rows(channelsBox())).toHaveLength(PAGE));
    expect(h.api.channelsPage).toHaveBeenCalledWith({ q: "", offset: 0, limit: PAGE });
    expect(within(channelsBox()).getByText("1 member")).toBeInTheDocument();
    expect(within(channelsBox()).getByText("5 members")).toBeInTheDocument();
    expect(within(channelsBox()).getAllByLabelText("Locked channel").length).toBeGreaterThan(0);

    scroll(channelsBox());
    await waitFor(() => expect(rows(channelsBox())).toHaveLength(2 * PAGE));
    scroll(channelsBox());
    await waitFor(() => expect(rows(channelsBox())).toHaveLength(75));
    expect(h.api.channelsPage).toHaveBeenLastCalledWith({ q: "", offset: 2 * PAGE, limit: PAGE });

    await user.click(within(channelsBox()).getByRole("checkbox", { name: /team-050/ }));
    expect(onChannels.mock.calls[0]![0]).toMatchObject({ name: "team-050", memberCount: 51 });
  });

  it("searches channels on the server, from the first page", async () => {
    const user = mount();
    await user.click(screen.getByRole("tab", { name: /Channels/ }));
    await waitFor(() => expect(rows(channelsBox())).toHaveLength(PAGE));
    h.api.channelsPage.mockClear();
    await user.type(screen.getByRole("searchbox", { name: "Search your channels" }), "team-06");
    await waitFor(() => expect(h.api.channelsPage).toHaveBeenCalledTimes(1));
    expect(h.api.channelsPage).toHaveBeenCalledWith({ q: "team-06", offset: 0, limit: PAGE });
    await waitFor(() => expect(rows(channelsBox())).toHaveLength(10));
  });

  it("shows 'Loading more channels…' while fetching the next page", async () => {
    const user = mount();
    await user.click(screen.getByRole("tab", { name: /Channels/ }));
    await waitFor(() => expect(rows(channelsBox())).toHaveLength(PAGE));
    let release!: () => void;
    const real = pagedChannels(makeChannels(75));
    h.api.channelsPage.mockImplementationOnce(async (a: never) => {
      await new Promise<void>((r) => (release = r));
      return real(a);
    });
    scroll(channelsBox());
    expect(await screen.findByText("Loading more channels…")).toBeInTheDocument();
    await act(async () => release());
    await waitFor(() => expect(rows(channelsBox())).toHaveLength(2 * PAGE));
  });
});

describe("project-derived channels", () => {
  const DERIVED: ChannelPickLike[] = [{ id: "chan-derived-1", name: "launch-plan-chat", memberCount: 4 }];

  it("shows a project-derived channel as its own row, tagged, above the ordinary list", async () => {
    const user = mount("channels", DERIVED);
    await waitFor(() => expect(rows(channelsBox())).toHaveLength(PAGE + 1));
    const row = within(channelsBox()).getByText("launch-plan-chat").closest("li")!;
    expect(row).toHaveTextContent("From a project");
    expect(within(row).getByRole("checkbox")).toBeChecked();

    // It is the first row (above the ordinary paged list).
    const allRows = within(channelsBox()).getAllByRole("checkbox");
    expect(allRows[0]).toBe(within(row).getByRole("checkbox"));
    await user.click(within(row).getByRole("checkbox"));
    expect(onChannels.mock.calls[0]![0]).toMatchObject({ id: "chan-derived-1", name: "launch-plan-chat" });
  });

  it("never shows a project-derived channel twice, even if it is also on the loaded picker page", async () => {
    const onPage = makeChannels(5)[2]!;
    const derived: ChannelPickLike[] = [{ id: onPage.id, name: onPage.name, memberCount: onPage.memberCount }];
    h.api.channelsPage.mockResolvedValue(makeChannels(5));
    mount("channels", derived);
    await waitFor(() => expect(rows(channelsBox())).toHaveLength(5));
    expect(within(channelsBox()).getAllByText(onPage.name)).toHaveLength(1);
  });

  it("an unchecked project-derived row can be checked again", async () => {
    const user = mount("channels", DERIVED);
    await waitFor(() => expect(rows(channelsBox())).toHaveLength(PAGE + 1));
    const checkbox = within(channelsBox()).getByRole("checkbox", { name: /launch-plan-chat/ });
    expect(checkbox).toBeChecked();
    await user.click(checkbox); // uncheck
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox); // check again
    expect(checkbox).toBeChecked();
    expect(onChannels).toHaveBeenCalledTimes(2);
  });
});

describe("projects", () => {
  const PROJECTS: ProjectDTO[] = [
    { id: "proj-1", name: "Website Redesign", channelId: "chan-1", channelIds: ["chan-1", "chan-2"], status: "ACTIVE", canComplete: false },
    { id: "proj-2", name: "Q3 Launch", channelId: "chan-3", channelIds: ["chan-3"], status: "ACTIVE", canComplete: false },
  ];

  it("lists projects and reports the whole project when picked", async () => {
    h.api.projects.mockResolvedValue(PROJECTS);
    const user = mount("projects");
    await waitFor(() => expect(rows(projectsBox())).toHaveLength(2));
    expect(within(projectsBox()).getByText("Website Redesign")).toBeInTheDocument();
    expect(within(projectsBox()).getByText("2 channels")).toBeInTheDocument();

    await user.click(within(projectsBox()).getByRole("checkbox", { name: /Website Redesign/ }));
    expect(onProjects.mock.calls[0]![0]).toMatchObject({ id: "proj-1", name: "Website Redesign" });
    expect(screen.getByRole("tab", { name: /Projects \(1\)/ })).toBeInTheDocument();
  });

  it("filters projects by name client-side", async () => {
    h.api.projects.mockResolvedValue(PROJECTS);
    const user = mount("projects");
    await waitFor(() => expect(rows(projectsBox())).toHaveLength(2));
    await user.type(screen.getByRole("searchbox", { name: "Search your projects" }), "Launch");
    await waitFor(() => expect(rows(projectsBox())).toHaveLength(1));
    expect(within(projectsBox()).getByText("Q3 Launch")).toBeInTheDocument();
  });

  it("says so when there are no projects", async () => {
    h.api.projects.mockResolvedValue([]);
    mount("projects");
    expect(await screen.findByText("No projects match your search.")).toBeInTheDocument();
  });
});

describe("failure", () => {
  it("offers a retry when the first page cannot be loaded", async () => {
    h.api.directoryPage.mockReset().mockRejectedValueOnce(new Error("down")).mockImplementation(pagedDirectory(makeUsers(5)));
    const user = mount();
    expect(await screen.findByText("Couldn't load this list.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(rows(peopleBox())).toHaveLength(5));
  });
});

describe("guidance on the Channels tab", () => {
  it("is a note inside the list's own box, so it costs the rows room rather than the dialog height", async () => {
    const user = mount();
    await user.click(screen.getByRole("tab", { name: /Channels/ }));
    await waitFor(() => expect(rows(channelsBox())).toHaveLength(PAGE));
    const hint = screen.getByText(/Every member of the channel receives the task/);
    const box = channelsBox().parentElement!.parentElement!;
    expect(box).toContainElement(hint);
    expect(box).toHaveClass("min-h-[20rem]", "overflow-hidden");
    expect(channelsBox()).not.toContainElement(hint); // not a scrolling row
  });
});
