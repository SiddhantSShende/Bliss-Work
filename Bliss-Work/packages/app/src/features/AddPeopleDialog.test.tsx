/**
 * "Add people" from inside a call. An ad-hoc call adds people to the call itself
 * (the server rings them) and never goes near a meeting link; a meeting keeps
 * its link flow.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "../store/session";
import { ADA, DIRECTORY, GRACE, ME } from "../test/meetingFixtures";

const h = vi.hoisted(() => ({
  api: { directory: vi.fn(), createCallInvite: vi.fn(), sendMessage: vi.fn() },
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: h.api, config: { webBaseUrl: "https://app.test" } }),
}));
vi.mock("sonner", () => ({ toast: h.toast }));

import { AddPeopleDialog } from "./AddPeopleDialog";

function renderDialog(props: Partial<React.ComponentProps<typeof AddPeopleDialog>> = {}) {
  const onAdd = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AddPeopleDialog open onClose={onClose} exclude={new Set()} onAdd={onAdd} {...props} />
    </QueryClientProvider>,
  );
  return { onAdd, onClose, user: userEvent.setup() };
}

beforeEach(() => {
  useSession.setState({ user: ME });
  h.api.directory.mockReset().mockResolvedValue(DIRECTORY);
  h.api.createCallInvite.mockReset().mockResolvedValue({ token: "tok" });
  h.api.sendMessage.mockReset().mockResolvedValue({});
  Object.values(h.toast).forEach((f) => f.mockReset());
});

describe.each([
  ["an ad-hoc call in the room", { callId: "call-1", adhoc: true }],
  ["the 1:1 overlay, which has no call id yet", {}],
])("adding to %s", (_name, props) => {
  it("goes straight to choosing people — no meeting-link step", async () => {
    renderDialog(props);

    expect(await screen.findByRole("button", { name: /Ada Lovelace/ })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Add people to this call" })).toBeInTheDocument();
    expect(screen.queryByText(/meeting/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /send link/i })).toBeNull();
  });

  it("adds everyone picked to the call, never mints a link or sends a message", async () => {
    const { user, onAdd, onClose } = renderDialog(props);

    await user.click(await screen.findByRole("button", { name: /Ada Lovelace/ }));
    await user.click(screen.getByRole("button", { name: /Grace Hopper/ }));
    await user.click(screen.getByRole("button", { name: "Add 2" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onAdd).toHaveBeenCalledExactlyOnceWith([ADA.id, GRACE.id]);
    expect(h.api.createCallInvite).not.toHaveBeenCalled();
    expect(h.api.sendMessage).not.toHaveBeenCalled();
    expect(h.toast.success).toHaveBeenCalledWith("Added 2 people");
  });

  it("says so when nobody could be added, and stays open", async () => {
    const { user, onAdd, onClose } = renderDialog(props);
    onAdd.mockRejectedValue(new Error("call has reached its participant limit"));

    await user.click(await screen.findByRole("button", { name: /Ada Lovelace/ }));
    await user.click(screen.getByRole("button", { name: "Add 1" }));

    await waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    expect(h.toast.error.mock.calls[0]![1]).toMatchObject({ description: "call has reached its participant limit" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("adding to a meeting", () => {
  it("still offers the meeting link", async () => {
    const { user, onAdd } = renderDialog({ callId: "call-1" });

    expect(screen.getByText("Invite teammates to join this meeting with a secure link.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send link" }));
    await user.click(await screen.findByRole("button", { name: /Ada Lovelace/ }));
    await user.click(screen.getByRole("button", { name: "Send link 1" }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledExactlyOnceWith([ADA.id]));
    expect(h.api.createCallInvite).toHaveBeenCalledWith("call-1");
    expect(h.api.sendMessage).toHaveBeenCalledWith(ADA.id, expect.stringContaining("Join the meeting: "));
  });
});
