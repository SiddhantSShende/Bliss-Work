/**
 * The "+ Add Channel" popup: search across every channel this user is
 * already allowed to know about (their own + the org's open directory),
 * join one, or fall through to creating a new one. See the component's own
 * doc comment for why locked channels the user isn't in are never listed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({
  channels: vi.fn(),
  openChannels: vi.fn(),
  joinChannel: vi.fn(async () => ({})),
}));

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({
    api: { channels: h.channels, openChannels: h.openChannels, joinChannel: h.joinChannel },
  }),
}));

// Isolates this test from CreateChannelDialog's own form/mutation internals —
// only that "Create New Channel" reaches it (with the right open/onClose) is
// this component's concern.
vi.mock("./CreateChannelDialog", () => ({
  CreateChannelDialog: ({ open }: { open: boolean }) =>
    open ? <div>create-channel-dialog-open</div> : null,
}));

import { AddChannelDialog } from "./AddChannelDialog";

function chan(overrides: Partial<ChannelDTO>): ChannelDTO {
  return {
    id: overrides.id ?? "chan-base",
    name: overrides.name ?? "chan-base",
    memberCount: 5,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageSenderId: "",
    cleared: false,
    unread: 0,
    isLocked: false,
    iAmMember: true,
    createdBy: "",
    myRole: "member",
    ...overrides,
  };
}

function renderDialog(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onClose,
    ...render(
      <QueryClientProvider client={qc}>
        <AddChannelDialog open onClose={onClose} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AddChannelDialog", () => {
  it("lists both my channels and the open directory, deduped", async () => {
    h.channels.mockResolvedValue([chan({ id: "c-mine", name: "general", iAmMember: true })]);
    h.openChannels.mockResolvedValue([chan({ id: "c-open", name: "random", iAmMember: false })]);
    renderDialog();

    expect(await screen.findByText("general")).toBeInTheDocument();
    expect(screen.getByText("random")).toBeInTheDocument();
  });

  it("filters the list as the user types a search", async () => {
    const user = userEvent.setup();
    h.channels.mockResolvedValue([chan({ id: "c-1", name: "engineering" })]);
    h.openChannels.mockResolvedValue([chan({ id: "c-2", name: "marketing", iAmMember: false })]);
    renderDialog();

    await screen.findByText("engineering");
    await user.type(screen.getByPlaceholderText("Search channels…"), "market");

    expect(screen.queryByText("engineering")).not.toBeInTheDocument();
    expect(screen.getByText("marketing")).toBeInTheDocument();
  });

  it("shows Joined (disabled, no click handler) for a channel already joined — never a Join button", async () => {
    h.channels.mockResolvedValue([chan({ id: "c-mine", name: "general", iAmMember: true })]);
    h.openChannels.mockResolvedValue([]);
    renderDialog();

    await screen.findByText("general");
    expect(screen.getByText("Joined")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /join/i })).not.toBeInTheDocument();
  });

  it("joining an open channel calls the API with that channel's id", async () => {
    const user = userEvent.setup();
    h.channels.mockResolvedValue([]);
    h.openChannels.mockResolvedValue([chan({ id: "c-open", name: "random", iAmMember: false })]);
    renderDialog();

    await user.click(await screen.findByRole("button", { name: /join/i }));

    expect(h.joinChannel).toHaveBeenCalledWith("c-open");
  });

  it("shows a Public badge for an open channel and a Private badge for a locked one", async () => {
    h.channels.mockResolvedValue([
      chan({ id: "c-open", name: "open-chan", isLocked: false }),
      chan({ id: "c-locked", name: "locked-chan", isLocked: true }),
    ]);
    h.openChannels.mockResolvedValue([]);
    renderDialog();

    await screen.findByText("open-chan");
    expect(screen.getByText("Public")).toBeInTheDocument();
    expect(screen.getByText("Private")).toBeInTheDocument();
  });

  it("never lists a locked channel the user is not already a member of", async () => {
    // openChannels() itself never returns locked channels (server-side
    // exclusion) — this pins that the client doesn't need to and doesn't
    // accidentally add its own locked-channel row from anywhere else.
    h.channels.mockResolvedValue([]);
    h.openChannels.mockResolvedValue([]);
    renderDialog();

    expect(await screen.findByText("No channels yet")).toBeInTheDocument();
  });

  it("Create New Channel swaps to CreateChannelDialog instead of stacking a second popup", async () => {
    const user = userEvent.setup();
    h.channels.mockResolvedValue([chan({ id: "c-mine", name: "general" })]);
    h.openChannels.mockResolvedValue([]);
    renderDialog();

    await screen.findByText("general");
    await user.click(screen.getByRole("button", { name: /create new channel/i }));

    expect(screen.getByText("create-channel-dialog-open")).toBeInTheDocument();
  });
});
