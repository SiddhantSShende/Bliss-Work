/**
 * WHO a new meeting is for: the members picked one by one and the channels whose
 * members are all invited. The real dialog, its real pickers and the real
 * directory/channel queries run; only the network-facing api is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@taskboard/shared";
import { toast } from "sonner";
import { useSession } from "../store/session";
import { ADA, CHANNELS, DIRECTORY, GRACE, LINUS, ME } from "../test/meetingFixtures";

const h = vi.hoisted(() => ({
  api: { scheduleMeeting: vi.fn(), directory: vi.fn(), channels: vi.fn() },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { NewMeetingDialog } from "./NewMeetingDialog";

const onClose = vi.fn();
const onStarted = vi.fn();

function openDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NewMeetingDialog onClose={onClose} onStarted={onStarted} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

/** The one call the dialog made, or a failure saying it made none. */
function sent() {
  expect(h.api.scheduleMeeting).toHaveBeenCalledTimes(1);
  return h.api.scheduleMeeting.mock.calls[0]![0] as Record<string, unknown>;
}

async function startNow(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText("Enter meeting title"), "Standup");
  await user.click(screen.getByRole("button", { name: "Start Now" }));
}

const membersGroup = () => screen.getByRole("group", { name: "Members" });
const channelsGroup = () => screen.getByRole("group", { name: "Channels" });

beforeEach(() => {
  useSession.setState({ user: ME });
  h.api.scheduleMeeting.mockReset().mockResolvedValue({ id: "call-1" });
  h.api.directory.mockReset().mockResolvedValue(DIRECTORY);
  h.api.channels.mockReset().mockResolvedValue(CHANNELS);
  onClose.mockReset();
  onStarted.mockReset();
  vi.mocked(toast.error).mockReset();
});

describe("a plain meeting", () => {
  // Every existing client sends exactly this; it must not grow fields.
  it("sends no members, channels or recurrence", async () => {
    const user = openDialog();
    await startNow(user);
    const body = sent();
    expect(body.inviteeIds).toBeUndefined();
    expect(body.channelIds).toBeUndefined();
    expect(body.recurrence).toBeUndefined();
  });

  it("says plainly that nobody has been added", () => {
    openDialog();
    expect(within(membersGroup()).getByText("No members added yet.")).toBeInTheDocument();
    expect(within(channelsGroup()).getByText("No channels added yet.")).toBeInTheDocument();
  });
});

describe("members", () => {
  it("selects one member and sends them", async () => {
    const user = openDialog();
    await user.click(within(membersGroup()).getByRole("button", { name: "Add members" }));
    await user.click(await screen.findByRole("button", { name: /Ada Lovelace/ }));

    expect(within(membersGroup()).getByRole("list", { name: "Members" })).toHaveTextContent("Ada Lovelace");
    await startNow(user);
    expect(sent().inviteeIds).toEqual([ADA.id]);
  });

  it("selects several, in the order picked", async () => {
    const user = openDialog();
    await user.click(within(membersGroup()).getByRole("button", { name: "Add members" }));
    await user.click(await screen.findByRole("button", { name: /Grace Hopper/ }));
    await user.click(screen.getByRole("button", { name: /Ada Lovelace/ }));
    await user.click(screen.getByRole("button", { name: /Linus Torvalds/ }));

    const chips = within(membersGroup()).getAllByRole("listitem");
    expect(chips).toHaveLength(3);
    expect(chips[0]).toHaveTextContent("Grace Hopper");
    expect(chips[1]).toHaveTextContent("Ada Lovelace");
    expect(chips[2]).toHaveTextContent("Linus Torvalds");
    // The avatar's initials are decoration: the chip's accessible name is the name.
    expect(within(chips[0]!).getByText("Grace Hopper")).toBeVisible();
    await startNow(user);
    expect(sent().inviteeIds).toEqual([GRACE.id, ADA.id, LINUS.id]);
  });

  it("never offers the organiser, who is already the host", async () => {
    const user = openDialog();
    await user.click(within(membersGroup()).getByRole("button", { name: "Add members" }));
    await screen.findByRole("button", { name: /Ada Lovelace/ });
    expect(screen.queryByRole("button", { name: /Me Myself/ })).not.toBeInTheDocument();
  });

  it("searches by name and by email", async () => {
    const user = openDialog();
    await user.click(within(membersGroup()).getByRole("button", { name: "Add members" }));
    await screen.findByRole("button", { name: /Ada Lovelace/ });
    const search = screen.getByRole("textbox", { name: "Search your organisation" });

    await user.type(search, "hopp");
    expect(screen.getByRole("button", { name: /Grace Hopper/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ada Lovelace/ })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "linus@acme");
    expect(screen.getByRole("button", { name: /Linus Torvalds/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Grace Hopper/ })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.getByText("No matches.")).toBeInTheDocument();
  });

  it("removes a member with the chip's own button, and they are no longer sent", async () => {
    const user = openDialog();
    await user.click(within(membersGroup()).getByRole("button", { name: "Add members" }));
    await user.click(await screen.findByRole("button", { name: /Ada Lovelace/ }));
    await user.click(screen.getByRole("button", { name: /Grace Hopper/ }));

    await user.click(within(membersGroup()).getByRole("button", { name: "Remove Ada Lovelace" }));

    expect(within(membersGroup()).getAllByRole("listitem")).toHaveLength(1);
    // The picker row un-highlights too: one selection, shown in both places.
    expect(screen.getByRole("button", { name: /Ada Lovelace/ })).toHaveAttribute("aria-pressed", "false");
    await startNow(user);
    expect(sent().inviteeIds).toEqual([GRACE.id]);
  });

  it("a member cannot be added twice: picking again takes them off", async () => {
    const user = openDialog();
    await user.click(within(membersGroup()).getByRole("button", { name: "Add members" }));
    const row = await screen.findByRole("button", { name: /Ada Lovelace/ });
    await user.click(row);
    expect(within(membersGroup()).getAllByRole("listitem")).toHaveLength(1);
    await user.click(row);
    expect(within(membersGroup()).queryAllByRole("listitem")).toHaveLength(0);
    await user.click(row);
    expect(within(membersGroup()).getAllByRole("listitem")).toHaveLength(1);
  });

  it("opens the picker with the search box focused, and Done closes it", async () => {
    const user = openDialog();
    const toggle = within(membersGroup()).getByRole("button", { name: "Add members" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByRole("textbox", { name: "Search your organisation" })).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(within(membersGroup()).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("textbox", { name: "Search your organisation" })).not.toBeInTheDocument();
  });

  it("says when there is nobody to add", async () => {
    h.api.directory.mockResolvedValue([ME]);
    const user = openDialog();
    await user.click(within(membersGroup()).getByRole("button", { name: "Add members" }));
    expect(await screen.findByText("No one else to invite.")).toBeInTheDocument();
  });

  it("says it is loading rather than claiming nobody is there", async () => {
    h.api.directory.mockReturnValue(new Promise(() => {}));
    const user = openDialog();
    await user.click(within(membersGroup()).getByRole("button", { name: "Add members" }));
    expect(await screen.findByText("Loading people…")).toBeInTheDocument();
    expect(screen.queryByText("No one else to invite.")).not.toBeInTheDocument();
  });
});

describe("channels", () => {
  it("selects one channel and sends it", async () => {
    const user = openDialog();
    await user.click(within(channelsGroup()).getByRole("button", { name: "Add channels" }));
    await user.click(await screen.findByRole("button", { name: /general/ }));

    expect(within(channelsGroup()).getByRole("list", { name: "Channels" })).toHaveTextContent("general");
    await startNow(user);
    expect(sent().channelIds).toEqual([CHANNELS[0]!.id]);
  });

  it("selects several channels", async () => {
    const user = openDialog();
    await user.click(within(channelsGroup()).getByRole("button", { name: "Add channels" }));
    await user.click(await screen.findByRole("button", { name: /design/ }));
    await user.click(screen.getByRole("button", { name: /general/ }));
    await startNow(user);
    expect(sent().channelIds).toEqual([CHANNELS[1]!.id, CHANNELS[0]!.id]);
  });

  it("shows how many people a channel would invite", async () => {
    const user = openDialog();
    await user.click(within(channelsGroup()).getByRole("button", { name: "Add channels" }));
    const row = await screen.findByRole("button", { name: /general/ });
    expect(row).toHaveTextContent("12 members");
  });

  it("filters channels by name", async () => {
    const user = openDialog();
    await user.click(within(channelsGroup()).getByRole("button", { name: "Add channels" }));
    await screen.findByRole("button", { name: /general/ });
    const search = screen.getByRole("textbox", { name: "Search your channels" });

    await user.type(search, "DESI");
    expect(screen.getByRole("button", { name: /design/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /general/ })).not.toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "nope");
    expect(screen.getByText("No matches.")).toBeInTheDocument();
  });

  it("removes a channel with the chip's own button", async () => {
    const user = openDialog();
    await user.click(within(channelsGroup()).getByRole("button", { name: "Add channels" }));
    await user.click(await screen.findByRole("button", { name: /general/ }));
    await user.click(screen.getByRole("button", { name: /design/ }));
    await user.click(within(channelsGroup()).getByRole("button", { name: "Remove general" }));

    expect(within(channelsGroup()).getAllByRole("listitem")).toHaveLength(1);
    await startNow(user);
    expect(sent().channelIds).toEqual([CHANNELS[1]!.id]);
  });

  it("a channel cannot be added twice", async () => {
    const user = openDialog();
    await user.click(within(channelsGroup()).getByRole("button", { name: "Add channels" }));
    const row = await screen.findByRole("button", { name: /general/ });
    await user.click(row);
    await user.click(row);
    await user.click(row);
    expect(within(channelsGroup()).getAllByRole("listitem")).toHaveLength(1);
  });

  it("says when the caller is in no channels", async () => {
    h.api.channels.mockResolvedValue([]);
    const user = openDialog();
    await user.click(within(channelsGroup()).getByRole("button", { name: "Add channels" }));
    expect(await screen.findByText("You're not in any channels.")).toBeInTheDocument();
  });

  it("shows a loading state, then the channels", async () => {
    let release!: (v: typeof CHANNELS) => void;
    h.api.channels.mockReturnValue(new Promise((r) => (release = r)));
    const user = openDialog();
    await user.click(within(channelsGroup()).getByRole("button", { name: "Add channels" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Loading channels…");
    release(CHANNELS);
    expect(await screen.findByRole("button", { name: /general/ })).toBeInTheDocument();
  });

  it("shows an error with a retry that works", async () => {
    h.api.channels.mockRejectedValue(new Error("boom"));
    const user = openDialog();
    await user.click(within(channelsGroup()).getByRole("button", { name: "Add channels" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load your channels.");
    h.api.channels.mockResolvedValue(CHANNELS);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: /general/ })).toBeInTheDocument();
  });
});

describe("both together", () => {
  it("send members and channels in the same request", async () => {
    const user = openDialog();
    await user.click(within(membersGroup()).getByRole("button", { name: "Add members" }));
    await user.click(await screen.findByRole("button", { name: /Ada Lovelace/ }));
    await user.click(within(channelsGroup()).getByRole("button", { name: "Add channels" }));
    await user.click(await screen.findByRole("button", { name: /general/ }));
    await startNow(user);
    const body = sent();
    expect(body.inviteeIds).toEqual([ADA.id]);
    expect(body.channelIds).toEqual([CHANNELS[0]!.id]);
  });
});

describe("saving", () => {
  it("does not submit twice while the first request is in flight", async () => {
    h.api.scheduleMeeting.mockReturnValue(new Promise(() => {}));
    const user = openDialog();
    await user.type(screen.getByPlaceholderText("Enter meeting title"), "Standup");
    const go = screen.getByRole("button", { name: "Start Now" });
    await user.click(go);
    const busy = await screen.findByRole("button", { name: "Starting…" });
    expect(busy).toBeDisabled();
    await user.click(busy);
    await user.keyboard("{Enter}");
    expect(h.api.scheduleMeeting).toHaveBeenCalledTimes(1);
  });

  it("explains a 403 — a member or channel that is gone — rather than a generic failure", async () => {
    h.api.scheduleMeeting.mockRejectedValue(new ApiError(403, "forbidden"));
    const user = openDialog();
    await startNow(user);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Some of the members or channels you picked are no longer available.",
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the generic message for anything else, and stays open to retry", async () => {
    h.api.scheduleMeeting.mockRejectedValue(new ApiError(500, "internal error"));
    const user = openDialog();
    await startNow(user);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't schedule that meeting"));
    expect(screen.getByRole("button", { name: "Start Now" })).toBeEnabled();
  });
});
