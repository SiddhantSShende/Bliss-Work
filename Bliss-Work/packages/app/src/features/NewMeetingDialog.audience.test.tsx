/**
 * WHO a new meeting is for: the "Add" section's People and Channels tabs. The real dialog,
 * the real Add section and the real paging hooks run; only the network-facing api is
 * stubbed (with the same search + offset/limit semantics as the server's).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@taskboard/shared";
import { toast } from "sonner";
import { useSession } from "../store/session";
import { ADA, CHANNELS, DIRECTORY, GRACE, LINUS, ME } from "../test/meetingFixtures";
import { addChannel, addPerson, channelsList, channelsPageOf, directoryPageOf, peopleList } from "../test/meetingPaging";

const h = vi.hoisted(() => ({
  api: { scheduleMeeting: vi.fn(), createCallInvite: vi.fn(), directoryPage: vi.fn(), channelsPage: vi.fn() },
}));
vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: h.api, config: { webBaseUrl: "https://app.test" } }),
}));
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

async function submitMeeting(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText("Enter meeting title"), "Standup");
  await user.click(screen.getByRole("button", { name: /^(Start|Schedule) Meeting$/ }));
}

beforeEach(() => {
  useSession.setState({ user: ME });
  h.api.scheduleMeeting.mockReset().mockResolvedValue({ id: "call-1" });
  h.api.createCallInvite
    .mockReset()
    .mockResolvedValue({ id: "invite-1", callId: "call-1", token: "tok_abc", expiresAt: "2026-09-16T10:00:00.000Z" });
  h.api.directoryPage.mockReset().mockImplementation(directoryPageOf(DIRECTORY));
  h.api.channelsPage.mockReset().mockImplementation(channelsPageOf(CHANNELS));
  onClose.mockReset();
  onStarted.mockReset();
  vi.mocked(toast.error).mockReset();
});

/** A debounced search (250ms) plus a render, under a loaded CI box. */
const SLOW = { timeout: 4000 };
const peopleTab = () => screen.getByRole("tab", { name: /^People/ });
const channelsTab = () => screen.getByRole("tab", { name: /^Channels/ });
const row = (name: RegExp) => within(peopleList()).findByRole("button", { name }, SLOW);

describe("the Add section", () => {
  it("is required, says so, and has no optional wording", () => {
    openDialog();
    const section = screen.getByTestId("meeting-add-section");
    expect(within(section).getByText("Add")).toBeInTheDocument();
    expect(section).not.toHaveTextContent(/optional/i);
  });

  it("opens on People, with both tabs counted and no separate Members / Channels sections", async () => {
    openDialog();
    expect(peopleTab()).toHaveAttribute("aria-selected", "true");
    expect(channelsTab()).toHaveAttribute("aria-selected", "false");
    expect(peopleTab()).toHaveTextContent("People(0)");
    expect(channelsTab()).toHaveTextContent("Channels(0)");
    expect(await row(/Ada Lovelace/)).toBeVisible();
    // No old Add members / Add channels buttons or group panels.
    expect(screen.queryByRole("button", { name: /Add (members|channels)/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Members|Channels/ })).not.toBeInTheDocument();
  });

  it("shows the list at once, in a fixed-height box that scrolls inside itself", async () => {
    openDialog();
    await row(/Ada Lovelace/);
    expect(peopleList()).toHaveClass("h-72", "overflow-y-auto");
  });
});

describe("a meeting with nobody added", () => {
  it("is refused with a message under Add, and nothing is sent", async () => {
    const user = openDialog();
    await submitMeeting(user);
    expect(h.api.scheduleMeeting).not.toHaveBeenCalled();
    expect(within(screen.getByTestId("meeting-add-section")).getByRole("alert")).toHaveTextContent(
      "Add at least one person or channel.",
    );
  });

  it("is accepted once a person is added, a channel is added, or both", async () => {
    const user = openDialog();
    await submitMeeting(user);
    expect(h.api.scheduleMeeting).not.toHaveBeenCalled();
    await addChannel(user, /general/);
    await user.click(screen.getByRole("button", { name: /^(Start|Schedule) Meeting$/ }));
    expect(sent().channelIds).toEqual([CHANNELS[0]!.id]);
  });
});

describe("people", () => {
  it("selects one person and sends them", async () => {
    const user = openDialog();
    await addPerson(user, /Ada Lovelace/);

    expect(await row(/Ada Lovelace/)).toHaveAttribute("aria-pressed", "true");
    expect(peopleTab()).toHaveTextContent("People(1)");
    await submitMeeting(user);
    expect(sent().inviteeIds).toEqual([ADA.id]);
    expect(sent().channelIds).toBeUndefined();
  });

  it("selects several, in the order picked", async () => {
    const user = openDialog();
    await addPerson(user, /Grace Hopper/);
    await addPerson(user, /Ada Lovelace/);
    await addPerson(user, /Linus Torvalds/);

    expect(peopleTab()).toHaveTextContent("People(3)");
    await submitMeeting(user);
    expect(sent().inviteeIds).toEqual([GRACE.id, ADA.id, LINUS.id]);
  });

  it("never offers the organiser, who is already the host", async () => {
    openDialog();
    await row(/Ada Lovelace/);
    expect(within(peopleList()).queryByRole("button", { name: /Me Myself/ })).not.toBeInTheDocument();
  });

  it("searches by name and by email, on the server", async () => {
    const user = openDialog();
    await row(/Ada Lovelace/);
    const search = screen.getByRole("textbox", { name: "Search your organisation" });

    await user.type(search, "hopp");
    await waitFor(() => expect(within(peopleList()).queryByRole("button", { name: /Ada Lovelace/ })).not.toBeInTheDocument(), SLOW);
    expect(await row(/Grace Hopper/)).toBeInTheDocument();
    expect(h.api.directoryPage).toHaveBeenCalledWith(expect.objectContaining({ q: "hopp", offset: 0 }));

    await user.clear(search);
    await user.type(search, "linus@acme");
    expect(await row(/Linus Torvalds/)).toBeInTheDocument();
    await waitFor(() => expect(within(peopleList()).queryByRole("button", { name: /Grace Hopper/ })).not.toBeInTheDocument(), SLOW);

    await user.clear(search);
    await user.type(search, "zzz");
    expect(await within(peopleList()).findByText("No matches.", undefined, SLOW)).toBeInTheDocument();
  });

  it("a person cannot be added twice: picking again takes them off", async () => {
    const user = openDialog();
    const ada = await row(/Ada Lovelace/);
    await user.click(ada);
    expect(peopleTab()).toHaveTextContent("People(1)");
    await user.click(ada);
    expect(peopleTab()).toHaveTextContent("People(0)");
    expect(ada).toHaveAttribute("aria-pressed", "false");
    await user.click(ada);
    expect(peopleTab()).toHaveTextContent("People(1)");
  });

  it("says when there is nobody to add", async () => {
    h.api.directoryPage.mockImplementation(directoryPageOf([ME]));
    openDialog();
    expect(await screen.findByText("No one else to invite.")).toBeInTheDocument();
  });

  it("says it is loading rather than claiming nobody is there", async () => {
    h.api.directoryPage.mockReturnValue(new Promise(() => {}));
    openDialog();
    expect(await screen.findByText("Loading people…")).toBeInTheDocument();
    expect(screen.queryByText("No one else to invite.")).not.toBeInTheDocument();
  });

  it("shows an error with a retry that works", async () => {
    h.api.directoryPage.mockRejectedValueOnce(new Error("boom"));
    const user = openDialog();
    expect(await within(peopleList()).findByRole("alert")).toHaveTextContent("Couldn't load the next page.");
    await user.click(within(peopleList()).getByRole("button", { name: "Try again" }));
    expect(await row(/Ada Lovelace/)).toBeInTheDocument();
  });
});

describe("channels", () => {
  it("selects one channel and sends it", async () => {
    const user = openDialog();
    await addChannel(user, /general/);

    expect(channelsTab()).toHaveTextContent("Channels(1)");
    await submitMeeting(user);
    expect(sent().channelIds).toEqual([CHANNELS[0]!.id]);
    expect(sent().inviteeIds).toBeUndefined();
  });

  it("selects several channels", async () => {
    const user = openDialog();
    await addChannel(user, /design/);
    await user.click(within(channelsList()).getByRole("button", { name: /general/ }));
    await submitMeeting(user);
    expect(sent().channelIds).toEqual([CHANNELS[1]!.id, CHANNELS[0]!.id]);
  });

  it("shows how many people a channel would invite", async () => {
    const user = openDialog();
    await user.click(channelsTab());
    expect(await within(channelsList()).findByRole("button", { name: /general/ })).toHaveTextContent("12 members");
  });

  it("filters channels by name, on the server", async () => {
    const user = openDialog();
    await user.click(channelsTab());
    await within(channelsList()).findByRole("button", { name: /general/ });
    const search = screen.getByRole("textbox", { name: "Search your channels" });

    await user.type(search, "DESI");
    expect(await within(channelsList()).findByRole("button", { name: /design/ }, SLOW)).toBeInTheDocument();
    await waitFor(() => expect(within(channelsList()).queryByRole("button", { name: /general/ })).not.toBeInTheDocument(), SLOW);
    expect(h.api.channelsPage).toHaveBeenCalledWith(expect.objectContaining({ q: "DESI" }));
    await user.clear(search);
    await user.type(search, "nope");
    expect(await within(channelsList()).findByText("No matches.", undefined, SLOW)).toBeInTheDocument();
  });

  it("a channel can be taken off again by picking it again", async () => {
    const user = openDialog();
    await addChannel(user, /general/);
    const general = within(channelsList()).getByRole("button", { name: /general/ });
    await user.click(general);
    expect(channelsTab()).toHaveTextContent("Channels(0)");
    expect(general).toHaveAttribute("aria-pressed", "false");
  });

  it("says when the caller is in no channels", async () => {
    h.api.channelsPage.mockImplementation(channelsPageOf([]));
    const user = openDialog();
    await user.click(channelsTab());
    expect(await screen.findByText("You're not in any channels.")).toBeInTheDocument();
  });

  it("shows a loading state, then the channels", async () => {
    let release!: (v: typeof CHANNELS) => void;
    h.api.channelsPage.mockReturnValue(new Promise((r) => (release = r)));
    const user = openDialog();
    await user.click(channelsTab());
    expect(await within(channelsList()).findByRole("status")).toHaveTextContent("Loading channels…");
    release(CHANNELS);
    expect(await within(channelsList()).findByRole("button", { name: /general/ })).toBeInTheDocument();
  });

  it("shows an error with a retry that works", async () => {
    h.api.channelsPage.mockRejectedValueOnce(new Error("boom"));
    const user = openDialog();
    await user.click(channelsTab());
    expect(await within(channelsList()).findByRole("alert")).toHaveTextContent("Couldn't load your channels.");
    await user.click(within(channelsList()).getByRole("button", { name: "Try again" }));
    expect(await within(channelsList()).findByRole("button", { name: /general/ })).toBeInTheDocument();
  });
});

describe("both together", () => {
  it("send people and channels in the same request, and the preview counts both", async () => {
    const user = openDialog();
    await addPerson(user, /Ada Lovelace/);
    await addChannel(user, /general/);
    expect(screen.getByText("1 member")).toBeInTheDocument();
    expect(screen.getByText("1 channel")).toBeInTheDocument();
    await submitMeeting(user);
    const body = sent();
    expect(body.inviteeIds).toEqual([ADA.id]);
    expect(body.channelIds).toEqual([CHANNELS[0]!.id]);
  });

  it("keeps each tab's selection and search when switching back and forth", async () => {
    const user = openDialog();
    await addPerson(user, /Ada Lovelace/);
    await user.type(screen.getByRole("textbox", { name: "Search your organisation" }), "ada");
    await addChannel(user, /general/);
    await user.click(peopleTab());
    expect(screen.getByRole("textbox", { name: "Search your organisation" })).toHaveValue("ada");
    expect(await row(/Ada Lovelace/)).toHaveAttribute("aria-pressed", "true");
    expect(channelsTab()).toHaveTextContent("Channels(1)");
  });
});

describe("saving", () => {
  it("does not submit twice while the first request is in flight", async () => {
    h.api.scheduleMeeting.mockReturnValue(new Promise(() => {}));
    const user = openDialog();
    await addPerson(user, /Ada Lovelace/);
    await user.type(screen.getByPlaceholderText("Enter meeting title"), "Standup");
    const go = screen.getByRole("button", { name: /^(Start|Schedule) Meeting$/ });
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
    await addPerson(user, /Ada Lovelace/);
    await submitMeeting(user);
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
    await addPerson(user, /Ada Lovelace/);
    await submitMeeting(user);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't schedule that meeting"));
    expect(screen.getByRole("button", { name: /^(Start|Schedule) Meeting$/ })).toBeEnabled();
  });
});
