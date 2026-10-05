import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "../store/session";
import { ADA, CHANNELS, DESIGN, DIRECTORY, GENERAL, GRACE, ME } from "../test/meetingFixtures";

const h = vi.hoisted(() => ({ api: { directory: vi.fn(), channels: vi.fn() } }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));

import { AddParticipantsPicker } from "./AddParticipantsPicker";

function renderPicker(props: Partial<React.ComponentProps<typeof AddParticipantsPicker>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AddParticipantsPicker excludeUserIds={new Set()} confirmLabel="Add" onConfirm={onConfirm} onCancel={onCancel} {...props} />
    </QueryClientProvider>,
  );
  return { onConfirm, onCancel, user: userEvent.setup() };
}
const selected = () => screen.getByRole("list", { name: "Selected participants" });

beforeEach(() => {
  useSession.setState({ user: ME });
  h.api.directory.mockReset().mockResolvedValue(DIRECTORY);
  h.api.channels.mockReset().mockResolvedValue(CHANNELS);
});

describe("AddParticipantsPicker", () => {
  it("starts on People, with the teammate search, and Add disabled until something is picked", async () => {
    renderPicker();

    expect(screen.getByRole("tab", { name: "People", selected: true })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Ada Lovelace/ })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search your organisation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Add/ })).toBeDisabled();
  });

  it("never offers someone who is already on the task", async () => {
    renderPicker({ excludeUserIds: new Set([ADA.id]) });

    expect(await screen.findByRole("button", { name: /Grace Hopper/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ada Lovelace/ })).not.toBeInTheDocument();
  });

  it("submits people and channels together, keeping the people picked before switching tabs", async () => {
    const { user, onConfirm } = renderPicker();

    await user.click(await screen.findByRole("button", { name: /Ada Lovelace/ }));
    await user.click(screen.getByRole("button", { name: /Grace Hopper/ }));
    await user.click(screen.getByRole("tab", { name: /Channels/ }));
    await user.click(await screen.findByRole("button", { name: /design/ }));
    await user.click(screen.getByRole("button", { name: /general/ }));

    // Back on People the picks are still there; the Add count is people + channels.
    await user.click(screen.getByRole("tab", { name: /People/ }));
    expect(await within(screen.getByRole("tabpanel")).findByRole("button", { name: /Ada Lovelace/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Add 4" }));

    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({
      userIds: [ADA.id, GRACE.id],
      channelIds: [DESIGN.id, GENERAL.id],
    });
  });

  it("shows people and channels apart in the selected list, and each can be removed", async () => {
    const { user, onConfirm } = renderPicker();
    await user.click(await screen.findByRole("button", { name: /Ada Lovelace/ }));
    await user.click(screen.getByRole("tab", { name: /Channels/ }));
    await user.click(await screen.findByRole("button", { name: /design/ }));

    const items = within(selected()).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-kind"))).toEqual(["person", "channel"]);
    expect(items[0]).toHaveTextContent("Ada Lovelace");
    expect(items[0]).toHaveTextContent("Person");
    expect(items[1]).toHaveTextContent("design");
    expect(items[1]).toHaveTextContent("Channel");

    await user.click(within(items[0]!).getByRole("button", { name: "Remove Ada Lovelace" }));
    await user.click(screen.getByRole("button", { name: "Add 1" }));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ userIds: [], channelIds: [DESIGN.id] });
  });

  it("a channel alone is enough, and picking it twice selects it once (the second click un-picks it)", async () => {
    const { user, onConfirm } = renderPicker();
    await user.click(screen.getByRole("tab", { name: "Channels" }));

    const design = await screen.findByRole("button", { name: /design/ });
    await user.click(design);
    expect(design).toHaveAttribute("aria-pressed", "true");
    expect(within(selected()).getAllByRole("listitem")).toHaveLength(1);
    await user.click(design);
    expect(screen.queryByRole("list", { name: "Selected participants" })).not.toBeInTheDocument();
    await user.click(design);

    await user.click(screen.getByRole("button", { name: "Add 1" }));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ userIds: [], channelIds: [DESIGN.id] });
  });

  it("filters the channel list by the search box", async () => {
    const { user } = renderPicker();
    await user.click(screen.getByRole("tab", { name: "Channels" }));
    await screen.findByRole("button", { name: /general/ });

    await user.type(screen.getByRole("textbox", { name: "Search your channels" }), "des");

    expect(screen.getByRole("button", { name: /design/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /general/ })).not.toBeInTheDocument();
  });

  it("Cancel closes without submitting", async () => {
    const { user, onCancel, onConfirm } = renderPicker();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
