/**
 * MyTasksFilters now wraps TaskFilterAssignPanel — the same server-paged,
 * searchable People/Channels tabs as the New Task dialog's "Assign to" panel
 * — plus the status chips, Clear filters button, and the channel-members
 * failed-to-load retry notice that are specific to the filter.
 */
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { UserDTO, ChannelDTO } from "@taskboard/shared";
import { stubScrollGeometry, pagedDirectory, pagedChannels } from "../test/pagedPickerApi";
import { NO_SENT_FILTER, type ChannelMembers, type SentTaskFilter } from "../lib/sentTaskFilter";

const h = vi.hoisted(() => ({ api: { directoryPage: vi.fn(), channelsPage: vi.fn() } }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));

import { MyTasksFilters } from "./MyTasksFilters";

// A plain object, not UserDTO.parse(id): these ids are referenced directly in
// assertions below, so they stay readable rather than real UUIDs.
const person = (id: string, username: string): UserDTO =>
  ({
    id, orgId: "00000000-0000-4000-8000-000000000999", orgName: "Acme", username, displayName: username,
    email: `${username}@acme.test`, roles: ["member"], avatarUrl: null, mfaEnrolled: false,
    orgRequireMfaForAdmins: false, orgMfaGracePeriodEndsAt: null, themePrefs: null,
  }) as UserDTO;
const ANN = person("u-ann", "ann");
const BEN = person("u-ben", "ben");
const CY = person("u-cy", "cy");
const PEOPLE = [ANN, BEN, CY];

// A plain object, not ChannelDTO.parse(id): these ids are referenced directly in
// assertions below, so they stay readable rather than real UUIDs.
const chan = (id: string, name: string, memberCount: number): ChannelDTO =>
  ({ id, name, memberCount, lastMessage: null, lastMessageAt: null }) as ChannelDTO;
const ALPHA = chan("c-a", "alpha", 2);
const BETA = chan("c-b", "beta", 2);
const GAMMA = chan("c-c", "gamma", 0);
const CHANNELS = [ALPHA, BETA, GAMMA];
const CHANNEL_NAMES = CHANNELS.map((c) => ({ id: c.id, name: c.name }));

let restoreGeometry: () => void;

function Harness({
  onFilter,
  channels = CHANNEL_NAMES,
  channelMembers,
  onRetryChannel,
}: {
  onFilter: (f: SentTaskFilter) => void;
  channels?: typeof CHANNEL_NAMES;
  channelMembers?: ChannelMembers;
  onRetryChannel?: (id: string) => void;
}) {
  const [filter, setFilter] = useState(NO_SENT_FILTER);
  return (
    <MyTasksFilters
      filter={filter}
      onChange={(f) => { setFilter(f); onFilter(f); }}
      channels={channels}
      channelMembers={channelMembers}
      onRetryChannel={onRetryChannel}
    />
  );
}

function mount(props: Partial<Parameters<typeof Harness>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onFilter = props.onFilter ?? (() => {});
  render(
    <QueryClientProvider client={qc}>
      <Harness {...props} onFilter={onFilter} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const peopleBox = () => screen.getByLabelText("People to filter by");
const channelsBox = () => screen.getByLabelText("Channels to filter by");
const openChannelsTab = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("tab", { name: /^Channels/ }));

beforeEach(() => {
  restoreGeometry = stubScrollGeometry();
  h.api.directoryPage.mockReset().mockImplementation(pagedDirectory(PEOPLE));
  h.api.channelsPage.mockReset().mockImplementation(pagedChannels(CHANNELS));
});
afterEach(() => restoreGeometry());

describe("MyTasksFilters tabs", () => {
  it("defaults to People, 0/0, and does not ask for channels until that tab opens", async () => {
    mount();
    expect(screen.getByRole("tab", { name: "People (0)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Channels (0)" })).toHaveAttribute("aria-selected", "false");
    await waitFor(() => expect(within(peopleBox()).getAllByRole("checkbox")).toHaveLength(3));
    expect(h.api.channelsPage).not.toHaveBeenCalled();
  });

  it("opens the Channels tab on click and loads it", async () => {
    const user = mount();
    await openChannelsTab(user);
    await waitFor(() => expect(within(channelsBox()).getAllByRole("checkbox")).toHaveLength(3));
    expect(h.api.channelsPage).toHaveBeenCalledWith({ q: "", offset: 0, limit: 30 });
  });
});

describe("MyTasksFilters people", () => {
  it("selects several people, and the tab count follows", async () => {
    let last = NO_SENT_FILTER;
    const user = mount({ onFilter: (f) => (last = f) });
    await waitFor(() => expect(within(peopleBox()).getAllByRole("checkbox")).toHaveLength(3));

    await user.click(within(peopleBox()).getByRole("checkbox", { name: /ann$/ }));
    await user.click(within(peopleBox()).getByRole("checkbox", { name: /cy$/ }));
    expect([...last.personIds]).toEqual(["u-ann", "u-cy"]);
    expect(screen.getByRole("tab", { name: "People (2)" })).toBeInTheDocument();

    await user.click(within(peopleBox()).getByRole("checkbox", { name: /ann$/ }));
    expect([...last.personIds]).toEqual(["u-cy"]);
    expect(screen.getByRole("tab", { name: "People (1)" })).toBeInTheDocument();
  });

  it("searches people on the server after typing settles", async () => {
    const user = mount();
    await waitFor(() => expect(within(peopleBox()).getAllByRole("checkbox")).toHaveLength(3));
    h.api.directoryPage.mockClear();

    await user.type(screen.getByRole("searchbox", { name: "Search people in your organisation" }), "an");
    await waitFor(() => expect(h.api.directoryPage).toHaveBeenCalledWith({ q: "an", offset: 0, limit: 30 }));
    await waitFor(() => expect(within(peopleBox()).getAllByRole("checkbox")).toHaveLength(1));
    expect(within(peopleBox()).getByText("ann")).toBeInTheDocument();
  });

  it("says so when no person matches", async () => {
    const user = mount();
    await user.type(screen.getByRole("searchbox", { name: "Search people in your organisation" }), "zzzz");
    expect(await screen.findByText("No people match your search.")).toBeInTheDocument();
  });
});

describe("MyTasksFilters channels", () => {
  it("lists the channels with member counts and a channel search", async () => {
    const user = mount();
    await openChannelsTab(user);
    await waitFor(() => expect(within(channelsBox()).getAllByRole("checkbox")).toHaveLength(3));
    expect(within(channelsBox()).getAllByText("2 members")).toHaveLength(2); // alpha and beta
    expect(within(channelsBox()).getByText("0 members")).toBeInTheDocument(); // gamma

    await user.type(screen.getByRole("searchbox", { name: "Search your channels" }), "bet");
    await waitFor(() => expect(within(channelsBox()).getAllByRole("checkbox")).toHaveLength(1));
    await user.clear(screen.getByRole("searchbox", { name: "Search your channels" }));
    await user.type(screen.getByRole("searchbox", { name: "Search your channels" }), "zzzz");
    expect(await screen.findByText("No channels match your search.")).toBeInTheDocument();
  });

  it("ticks several channels without touching the explicit People selection, and clearing them leaves it intact", async () => {
    let last = NO_SENT_FILTER;
    const user = mount({ onFilter: (f) => (last = f) });
    await waitFor(() => expect(within(peopleBox()).getAllByRole("checkbox")).toHaveLength(3));
    await user.click(within(peopleBox()).getByRole("checkbox", { name: /ann$/ }));

    await openChannelsTab(user);
    await waitFor(() => expect(within(channelsBox()).getAllByRole("checkbox")).toHaveLength(3));
    await user.click(within(channelsBox()).getByRole("checkbox", { name: /^alpha/ }));
    await user.click(within(channelsBox()).getByRole("checkbox", { name: /^gamma/ }));
    expect([...last.channelIds]).toEqual(["c-a", "c-c"]);
    expect([...last.personIds]).toEqual(["u-ann"]);

    await user.click(within(channelsBox()).getByRole("checkbox", { name: /^alpha/ }));
    await user.click(within(channelsBox()).getByRole("checkbox", { name: /^gamma/ }));
    expect(last.channelIds.size).toBe(0);
    expect([...last.personIds]).toEqual(["u-ann"]);
  });

  it("Clear filters resets the channel selection too", async () => {
    let last = NO_SENT_FILTER;
    const user = mount({ onFilter: (f) => (last = f) });
    await openChannelsTab(user);
    await waitFor(() => expect(within(channelsBox()).getAllByRole("checkbox")).toHaveLength(3));
    await user.click(within(channelsBox()).getByRole("checkbox", { name: /^beta/ }));

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(last.channelIds.size).toBe(0);
  });
});

describe("MyTasksFilters people ticked through a channel", () => {
  // alpha: ann, ben. beta: ben, cy. gamma: nobody.
  const MEMBERS: ChannelMembers = new Map([
    ["c-a", ["u-ann", "u-ben"]],
    ["c-b", ["u-ben", "u-cy"]],
    ["c-c", []],
  ]);

  const backToPeopleTab = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("tab", { name: /^People/ }));

  it("shows a channel's people as softly ticked — and says why — without writing them into the People selection", async () => {
    let last = NO_SENT_FILTER;
    const user = mount({ onFilter: (f) => (last = f), channelMembers: MEMBERS });
    await openChannelsTab(user);
    await waitFor(() => expect(within(channelsBox()).getAllByRole("checkbox")).toHaveLength(3));
    await user.click(within(channelsBox()).getByRole("checkbox", { name: /^alpha/ }));
    await backToPeopleTab(user);

    await waitFor(() => expect(within(peopleBox()).getByRole("checkbox", { name: /ann$/ })).toBeChecked());
    expect(within(peopleBox()).getByRole("checkbox", { name: /ben$/ })).toBeChecked();
    expect(within(peopleBox()).getByRole("checkbox", { name: /cy$/ })).not.toBeChecked();
    expect(within(peopleBox()).getByRole("checkbox", { name: /ann$/ })).toHaveAccessibleDescription("Selected through a channel");
    expect(last.personIds.size).toBe(0);

    // Unticking the channel removes only what it alone contributed.
    await openChannelsTab(user);
    await waitFor(() => expect(within(channelsBox()).getAllByRole("checkbox")).toHaveLength(3));
    await user.click(within(channelsBox()).getByRole("checkbox", { name: /^alpha/ }));
    await backToPeopleTab(user);
    expect(within(peopleBox()).getByRole("checkbox", { name: /ann$/ })).not.toBeChecked();
    expect(within(peopleBox()).getByRole("checkbox", { name: /ann$/ })).not.toHaveAccessibleDescription();
  });

  it("an explicitly ticked person stays ticked, as an ordinary row, when their channel is deselected", async () => {
    let last = NO_SENT_FILTER;
    const user = mount({ onFilter: (f) => (last = f), channelMembers: MEMBERS });
    await waitFor(() => expect(within(peopleBox()).getAllByRole("checkbox")).toHaveLength(3));
    await user.click(within(peopleBox()).getByRole("checkbox", { name: /ann$/ }));

    await openChannelsTab(user);
    await waitFor(() => expect(within(channelsBox()).getAllByRole("checkbox")).toHaveLength(3));
    await user.click(within(channelsBox()).getByRole("checkbox", { name: /^alpha/ }));
    await backToPeopleTab(user);
    expect(within(peopleBox()).getByRole("checkbox", { name: /ann$/ })).not.toHaveAccessibleDescription();
    expect(within(peopleBox()).getByRole("checkbox", { name: /ben$/ })).toHaveAccessibleDescription("Selected through a channel");

    await openChannelsTab(user);
    await waitFor(() => expect(within(channelsBox()).getAllByRole("checkbox")).toHaveLength(3));
    await user.click(within(channelsBox()).getByRole("checkbox", { name: /^alpha/ }));
    await backToPeopleTab(user);
    expect(within(peopleBox()).getByRole("checkbox", { name: /ann$/ })).toBeChecked();
    expect(within(peopleBox()).getByRole("checkbox", { name: /ben$/ })).not.toBeChecked();
    expect([...last.personIds]).toEqual(["u-ann"]);
  });
});

describe("MyTasksFilters channel load failure", () => {
  it("says so with a Retry that asks for that channel again", async () => {
    const retried: string[] = [];
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MyTasksFilters
          filter={{ ...NO_SENT_FILTER, channelIds: new Set(["c-b"]) }}
          onChange={() => {}}
          channels={CHANNEL_NAMES}
          channelMembers={new Map([["c-b", null]])}
          onRetryChannel={(id) => retried.push(id)}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Couldn't load the members of beta, so no tasks are shown.")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(retried).toEqual(["c-b"]);
  });
});
