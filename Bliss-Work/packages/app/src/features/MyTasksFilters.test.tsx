import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NO_SENT_FILTER, type ChannelMembers, type SentTaskFilter } from "../lib/sentTaskFilter";
import { MyTasksFilters } from "./MyTasksFilters";

const PEOPLE = ["ann", "ben", "cy", "di", "ed"].map((name) => ({ id: `u-${name}`, username: name }));

const CHANNELS = [{ id: "c-a", name: "alpha" }, { id: "c-b", name: "beta" }, { id: "c-c", name: "gamma" }];

function Harness({ onFilter, channels, channelMembers }: { onFilter: (f: SentTaskFilter) => void; channels?: typeof CHANNELS; channelMembers?: ChannelMembers }) {
  const [filter, setFilter] = useState(NO_SENT_FILTER);
  return (
    <MyTasksFilters
      filter={filter}
      onChange={(f) => { setFilter(f); onFilter(f); }}
      people={PEOPLE}
      nameOf={(_id, fallback) => fallback ?? ""}
      avatarUrlOf={() => null}
      channels={channels}
      channelMembers={channelMembers}
    />
  );
}
const chips = () => screen.queryByRole("list", { name: "Selected people" });

describe("MyTasksFilters people", () => {
  it("selects several people with checkboxes and shows each as a removable chip", async () => {
    const user = userEvent.setup();
    let last = NO_SENT_FILTER;
    render(<Harness onFilter={(f) => (last = f)} />);
    expect(chips()).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "ann" }));
    await user.click(screen.getByRole("checkbox", { name: "cy" }));
    expect([...last.personIds]).toEqual(["u-ann", "u-cy"]);
    expect(within(chips()!).getAllByRole("listitem")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Remove ann" }));
    expect([...last.personIds]).toEqual(["u-cy"]);
    expect(screen.getByRole("checkbox", { name: "ann" })).not.toBeChecked();
  });

  it("searches by name without losing the selection", async () => {
    const user = userEvent.setup();
    render(<Harness onFilter={() => {}} />);
    await user.click(screen.getByRole("checkbox", { name: "ben" }));

    await user.type(screen.getByRole("searchbox", { name: "Search people…" }), "d");
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: "di" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "ed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove ben" })).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search people…" }), "zzz");
    expect(screen.getByText("No people match")).toBeInTheDocument();
  });

  it("folds chips past three into +N, which opens them all", async () => {
    const user = userEvent.setup();
    render(<Harness onFilter={() => {}} />);
    for (const name of ["ann", "ben", "cy", "di", "ed"]) await user.click(screen.getByRole("checkbox", { name }));

    expect(within(chips()!).getAllByRole("button", { name: /^Remove / })).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "+2" }));
    expect(within(chips()!).getAllByRole("button", { name: /^Remove / })).toHaveLength(5);
    await user.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(within(chips()!).getAllByRole("button", { name: /^Remove / })).toHaveLength(3);
  });

  it("keeps the list in its own scroll area", () => {
    render(<Harness onFilter={() => {}} />);
    expect(screen.getByRole("checkbox", { name: "ann" }).closest("ul")).toHaveClass("overflow-y-auto", "max-h-48");
  });
});

describe("MyTasksFilters circular controls", () => {
  const circleOf = (name: string) => screen.getByRole("checkbox", { name }).nextElementSibling as HTMLElement;

  it("draws each tick as a circle, not a native square box, and shows the selected state", async () => {
    const user = userEvent.setup();
    render(<Harness onFilter={() => {}} />);
    const box = screen.getByRole("checkbox", { name: "ann" });

    expect(box).toHaveClass("sr-only");
    expect(circleOf("ann")).toHaveClass("rounded-full", "border-border", "bg-surface");
    expect(circleOf("ann").querySelector("svg")).toBeNull();
    expect(box).not.toBeChecked();

    await user.click(box);
    expect(box).toBeChecked();
    expect(circleOf("ann").querySelector("svg")).not.toBeNull();
    expect(circleOf("ann")).toHaveClass("peer-checked:bg-accent", "peer-checked:border-accent");
  });

  it("is a labelled, keyboard-operable checkbox, and the whole row toggles it", async () => {
    const user = userEvent.setup();
    render(<Harness onFilter={() => {}} />);
    const box = screen.getByRole("checkbox", { name: "ben" });

    await user.click(screen.getByText("ben"));
    expect(box).toBeChecked();
    box.focus();
    await user.keyboard(" ");
    expect(box).not.toBeChecked();
  });
});

describe("MyTasksFilters channels", () => {
  const channelList = () => screen.getByRole("list", { name: "Channels" });

  it("lists the channels with the same circular controls and a channel search", async () => {
    const user = userEvent.setup();
    render(<Harness onFilter={() => {}} channels={CHANNELS} />);
    expect(screen.getByText("Channels")).toBeInTheDocument();
    expect(within(channelList()).getAllByRole("checkbox")).toHaveLength(3);
    expect(within(channelList()).getByRole("checkbox", { name: "alpha" }).nextElementSibling).toHaveClass("rounded-full");

    await user.type(screen.getByRole("searchbox", { name: "Search channels…" }), "et");
    expect(within(channelList()).getAllByRole("checkbox")).toHaveLength(1);
    await user.type(screen.getByRole("searchbox", { name: "Search channels…" }), "zzz");
    expect(screen.getByText("No channels match")).toBeInTheDocument();
  });

  it("ticks several channels without touching the explicit People selection, and clearing them leaves it intact", async () => {
    const user = userEvent.setup();
    let last = NO_SENT_FILTER;
    render(<Harness onFilter={(f) => (last = f)} channels={CHANNELS} />);
    await user.click(screen.getByRole("checkbox", { name: "ann" }));

    await user.click(within(channelList()).getByRole("checkbox", { name: "alpha" }));
    await user.click(within(channelList()).getByRole("checkbox", { name: "gamma" }));
    expect([...last.channelIds]).toEqual(["c-a", "c-c"]);
    expect([...last.personIds]).toEqual(["u-ann"]);

    await user.click(within(channelList()).getByRole("checkbox", { name: "alpha" }));
    await user.click(within(channelList()).getByRole("checkbox", { name: "gamma" }));
    expect(last.channelIds.size).toBe(0);
    expect([...last.personIds]).toEqual(["u-ann"]);
    expect(screen.getByRole("checkbox", { name: "ann" })).toBeChecked();
  });

  it("Clear filters resets the channel selection too", async () => {
    const user = userEvent.setup();
    let last = NO_SENT_FILTER;
    render(<Harness onFilter={(f) => (last = f)} channels={CHANNELS} />);
    await user.click(within(channelList()).getByRole("checkbox", { name: "beta" }));
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
  const channelBox = (name: string) => within(screen.getByRole("list", { name: "Channels" })).getByRole("checkbox", { name });
  const person = (name: string) => screen.getByRole("checkbox", { name });
  const renderWith = (onFilter: (f: SentTaskFilter) => void = () => {}) =>
    render(<Harness onFilter={onFilter} channels={CHANNELS} channelMembers={MEMBERS} />);

  it("shows a channel's people as ticked — and says why — without writing them into the People selection", async () => {
    const user = userEvent.setup();
    let last = NO_SENT_FILTER;
    renderWith((f) => (last = f));
    expect(person("ann")).not.toBeChecked();

    await user.click(channelBox("alpha"));
    expect(person("ann")).toBeChecked();
    expect(person("ben")).toBeChecked();
    expect(person("cy")).not.toBeChecked();
    expect(person("ann")).toHaveAccessibleDescription("Selected through a channel");
    expect(person("ann").closest("label")).toHaveAttribute("title", "Selected through a channel");
    // Logically still channel-derived: nothing in the explicit selection, no chips.
    expect(last.personIds.size).toBe(0);
    expect(chips()).not.toBeInTheDocument();
  });

  it("deselecting the channel unticks only what it alone contributed", async () => {
    const user = userEvent.setup();
    renderWith();
    await user.click(channelBox("alpha"));
    await user.click(channelBox("alpha"));

    expect(person("ann")).not.toBeChecked();
    expect(person("ben")).not.toBeChecked();
    expect(person("ann")).not.toHaveAccessibleDescription();
  });

  it("an explicitly ticked person stays ticked, as an ordinary row, when their channel is deselected", async () => {
    const user = userEvent.setup();
    let last = NO_SENT_FILTER;
    renderWith((f) => (last = f));
    await user.click(person("ann"));
    await user.click(channelBox("alpha"));
    // Explicit AND in the channel: not shown as channel-only.
    expect(person("ann")).not.toHaveAccessibleDescription();
    expect(person("ben")).toHaveAccessibleDescription("Selected through a channel");

    await user.click(channelBox("alpha"));
    expect(person("ann")).toBeChecked();
    expect(person("ben")).not.toBeChecked();
    expect([...last.personIds]).toEqual(["u-ann"]);
  });

  it("someone in two selected channels stays ticked until both are deselected", async () => {
    const user = userEvent.setup();
    renderWith();
    await user.click(channelBox("alpha"));
    await user.click(channelBox("beta"));
    expect(person("ben")).toBeChecked();
    expect(person("cy")).toBeChecked();

    await user.click(channelBox("alpha"));
    expect(person("ben")).toBeChecked();
    expect(person("ann")).not.toBeChecked();

    await user.click(channelBox("beta"));
    expect(person("ben")).not.toBeChecked();
  });

  it("clearing the channels restores exactly the explicit People selection", async () => {
    const user = userEvent.setup();
    renderWith();
    await user.click(person("di"));
    await user.click(channelBox("alpha"));
    await user.click(channelBox("beta"));
    await user.click(channelBox("alpha"));
    await user.click(channelBox("beta"));

    expect(PEOPLE.filter((p) => (person(p.username) as HTMLInputElement).checked).map((p) => p.username)).toEqual(["di"]);
  });

  it("a ticked channel whose members failed says so with a Retry that asks for that channel again", async () => {
    const user = userEvent.setup();
    const retried: string[] = [];
    render(
      <MyTasksFilters
        filter={{ ...NO_SENT_FILTER, channelIds: new Set(["c-b"]) }}
        onChange={() => {}}
        people={PEOPLE}
        nameOf={(_id, fallback) => fallback ?? ""}
        avatarUrlOf={() => null}
        channels={CHANNELS}
        channelMembers={new Map([["c-b", null]])}
        onRetryChannel={(id) => retried.push(id)}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Couldn't load the members of beta, so no tasks are shown.");
    expect(channelBox("beta")).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(retried).toEqual(["c-b"]);
  });

  it("a channel with no members, or still loading, ticks nobody", async () => {
    const user = userEvent.setup();
    render(<Harness onFilter={() => {}} channels={CHANNELS} channelMembers={new Map()} />);
    await user.click(channelBox("alpha"));
    expect(screen.queryAllByRole("checkbox", { checked: true }).map((b) => b.getAttribute("type"))).toHaveLength(1); // only alpha itself
  });
});

