/**
 * "Create New Channel" — the create-tab content of the "+" popup
 * (AddChannelDialog). Member picking goes through the real, standalone
 * MemberPicker (stubbed here to isolate this file from its own search/select
 * internals, same pattern as AddPeopleDialog.test.tsx), accumulating ids
 * locally until Create is submitted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelDTO, UserDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({
  createChannel: vi.fn(async () => ({ id: "chan-new" }) as ChannelDTO),
  directory: vi.fn(async () => [] as UserDTO[]),
}));

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: { createChannel: h.createChannel, directory: h.directory } }),
}));

vi.mock("../store/session", () => ({
  useSession: (sel: (s: { user: { id: string } }) => unknown) => sel({ user: { id: "me" } }),
}));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

// Isolates this test from the real directory/search UI, same pattern as
// AddPeopleDialog.test.tsx — onConfirm is all this file's assertions need.
vi.mock("./MemberPicker", () => ({
  MemberPicker: ({ onConfirm }: { onConfirm: (ids: string[]) => void }) => (
    <button onClick={() => onConfirm(["u-1"])}>confirm-picker</button>
  ),
}));

import { CreateChannelPanel } from "./CreateChannelPanel";
import { toast } from "sonner";

function user(over: Partial<UserDTO> = {}): UserDTO {
  return {
    id: "u-1",
    displayName: "Ada Lovelace",
    username: "ada",
    avatarUrl: undefined,
    ...over,
  } as UserDTO;
}

function renderPanel(onCreated = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onCreated,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <CreateChannelPanel onCreated={onCreated} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.directory.mockResolvedValue([user()]);
});

describe("CreateChannelPanel", () => {
  it("requires a name before creating", async () => {
    // The input's own `required` attribute blocks native submission for a
    // fully empty field before this component's onSubmit ever runs — the
    // reachable case for its own guard is whitespace-only, which satisfies
    // `required` (non-empty) but fails the `.trim()` check.
    const u = userEvent.setup();
    renderPanel();

    await u.type(screen.getByPlaceholderText("design-team"), "   ");
    await u.click(screen.getByRole("button", { name: /create channel/i }));

    expect(toast.error).toHaveBeenCalledWith("Name the channel");
    expect(h.createChannel).not.toHaveBeenCalled();
  });

  it("shows no members initially, then adds one picked through MemberPicker", async () => {
    const u = userEvent.setup();
    renderPanel();

    expect(screen.getByText("No members added yet.")).toBeInTheDocument();

    await u.click(screen.getByText("Add Member").closest("button")!);
    await u.click(screen.getByText("confirm-picker"));

    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.queryByText("No members added yet.")).not.toBeInTheDocument();
  });

  it("removing a picked member clears it back to the empty state", async () => {
    const u = userEvent.setup();
    renderPanel();

    await u.click(screen.getByText("Add Member").closest("button")!);
    await u.click(screen.getByText("confirm-picker"));
    await screen.findByText("Ada Lovelace");

    await u.click(screen.getByRole("button", { name: /remove ada lovelace/i }));

    expect(screen.getByText("No members added yet.")).toBeInTheDocument();
  });

  it("creates the channel with the name, visibility and accumulated member ids", async () => {
    const u = userEvent.setup();
    renderPanel();

    await u.type(screen.getByPlaceholderText("design-team"), "eng-team");
    await u.click(screen.getByText("Locked").closest("button")!);
    await u.click(screen.getByText("Add Member").closest("button")!);
    await u.click(screen.getByText("confirm-picker"));
    await screen.findByText("Ada Lovelace");

    await u.click(screen.getByRole("button", { name: /create channel/i }));

    await vi.waitFor(() =>
      expect(h.createChannel).toHaveBeenCalledWith({
        name: "eng-team",
        memberIds: ["u-1"],
        isLocked: true,
      }),
    );
  });

  it("calls onCreated once the channel is created", async () => {
    const u = userEvent.setup();
    const { onCreated } = renderPanel();

    await u.type(screen.getByPlaceholderText("design-team"), "eng-team");
    await u.click(screen.getByRole("button", { name: /create channel/i }));

    await vi.waitFor(() => expect(onCreated).toHaveBeenCalled());
  });
});
