/**
 * The Add Channel popup: layout contract (own layer, pinned footer) and — the
 * part that must NOT have changed — what it sends and when.
 *
 * Geometry and stacking are verified in a real browser (jsdom has no layout);
 * what jsdom can pin is the structure that makes them work: the dialog is
 * portaled out of the pane that mounts it, sits in the elevated layer, and the
 * Create button lives in Modal's pinned footer while still submitting the form.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  api: {
    createChannel: vi.fn(),
    directory: vi.fn(),
    channels: vi.fn(),
    openChannels: vi.fn(),
  },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: { user: { id: string } }) => unknown) => sel({ user: { id: "me" } }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { AddChannelDialog } from "./AddChannelDialog";
import { Modal } from "./Modal";

const PEOPLE = [
  { id: "00000000-0000-4000-8000-000000000101", displayName: "Aarav Mehta", username: "aarav", email: "a@x.co", roles: [] },
  { id: "00000000-0000-4000-8000-000000000102", displayName: "Bina Rao", username: "bina", email: "b@x.co", roles: [] },
];

function renderDialog() {
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        {/* Mounted inside a pane, as ChannelsList does with its sidebar. */}
        <aside data-testid="pane">
          <AddChannelDialog open onClose={onClose} />
        </aside>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, onClose };
}

beforeEach(() => {
  h.api.createChannel.mockReset().mockResolvedValue({ id: "00000000-0000-4000-8000-0000000000bb" });
  h.api.directory.mockReset().mockResolvedValue(PEOPLE);
  h.api.channels.mockReset().mockResolvedValue([]);
  h.api.openChannels.mockReset().mockResolvedValue([]);
});

describe("AddChannelDialog — layout contract", () => {
  it("renders in its own layer, outside the pane that mounts it", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Add Channel" });

    // Not a descendant of the pane (whose siblings — the channel header — would
    // otherwise be able to paint over it), but of <body>, in the elevated layer.
    expect(screen.getByTestId("pane").contains(dialog)).toBe(false);
    const overlay = dialog.parentElement!;
    expect(overlay.parentElement).toBe(document.body);
    expect(overlay.className).toContain("z-[210]");
    expect(overlay.className).toContain("inset-0");
    // A lighter scrim than the default dialogs' black/40 + blur-sm.
    expect(overlay.className).toContain("bg-black/30");
    expect(overlay.className).not.toContain("backdrop-blur-sm");
  });

  it("keeps Create channel in the pinned footer, separate from the scrolling form", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Add Channel" });
    const create = await within(dialog).findByRole("button", { name: "Create channel" });

    const footer = create.closest("div.shrink-0");
    expect(footer).not.toBeNull();
    expect(footer!.className).toContain("border-t");
    // The form itself no longer carries the button — it is tied by `form=`.
    const form = dialog.querySelector("form")!;
    expect(form.contains(create)).toBe(false);
    expect(create.getAttribute("form")).toBe(form.id);
  });

  it("has no Create button (and no footer) on the Add Channel tab", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Add Channel" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Add Channel" }));

    expect(within(dialog).queryByRole("button", { name: "Create channel" })).toBeNull();
    expect(dialog.querySelector("div.shrink-0.border-t")).toBeNull();
    expect(await within(dialog).findByPlaceholderText("Search channels…")).toBeTruthy();
  });
});

describe("AddChannelDialog — what it sends (unchanged)", () => {
  it("creates an open channel with no members from the footer button", async () => {
    const { onClose } = renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Add Channel" });
    await userEvent.type(within(dialog).getByPlaceholderText("design-team"), "  ops  ");
    await userEvent.click(await within(dialog).findByRole("button", { name: "Create channel" }));

    await waitFor(() => expect(h.api.createChannel).toHaveBeenCalledTimes(1));
    expect(h.api.createChannel).toHaveBeenCalledWith({ name: "ops", memberIds: [], isLocked: false });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("creates a locked channel with the picked members, and Enter in the name field submits too", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Add Channel" });
    await userEvent.click(within(dialog).getByText("Locked"));
    await userEvent.click(within(dialog).getByText("Add Member"));
    await userEvent.click(await within(dialog).findByText("Aarav Mehta"));
    // The picker's confirm button ("Add", possibly with a count) — not "Add Member".
    const confirm = within(dialog).getAllByText(/^Add\b/, { selector: "button" }).find((b) => !/Member|Channel/.test(b.textContent ?? ""))!;
    await userEvent.click(confirm);
    await waitFor(() => expect(dialog.querySelector("ul")?.textContent).toContain("Aarav Mehta"));

    await userEvent.type(within(dialog).getByPlaceholderText("design-team"), "dev{Enter}");

    await waitFor(() => expect(h.api.createChannel).toHaveBeenCalledTimes(1));
    expect(h.api.createChannel).toHaveBeenCalledWith({
      name: "dev",
      memberIds: [PEOPLE[0]!.id],
      isLocked: true,
    });
  });

  it("does not create without a name", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Add Channel" });
    await userEvent.click(await within(dialog).findByRole("button", { name: "Create channel" }));
    expect(h.api.createChannel).not.toHaveBeenCalled();
  });
});

describe("Modal — elevated is opt-in", () => {
  it("leaves an ordinary dialog exactly where and how it was", () => {
    const { container } = render(
      <Modal open onClose={() => {}} title="Plain">
        body
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Plain" });
    const overlay = dialog.parentElement!;
    expect(container.contains(dialog)).toBe(true); // not portaled
    expect(overlay.className).toContain("z-50");
    expect(overlay.className).toContain("bg-black/40");
    expect(overlay.className).toContain("backdrop-blur-sm");
  });
});
