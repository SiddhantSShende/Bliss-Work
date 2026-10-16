/**
 * The multi-select "Call": several people picked, ONE call made, the caller
 * taken into it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "../store/session";
import { ADA, DIRECTORY, GRACE, LINUS, ME, OCCURRENCE } from "../test/meetingFixtures";

const h = vi.hoisted(() => ({
  api: { directory: vi.fn(), startConferenceCall: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn() },
  session: { call: null as unknown, enter: vi.fn() },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("../lib/MeetingSession", () => ({ useMeetingSession: () => h.session }));

import { GroupCallDialog } from "./GroupCallDialog";

const CONFERENCE = { ...OCCURRENCE, kind: "DIRECT", scheduledAt: undefined, status: "LIVE" };

function renderDialog() {
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <GroupCallDialog open onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose, user: userEvent.setup() };
}

beforeEach(() => {
  useSession.setState({ user: ME });
  h.api.directory.mockReset().mockResolvedValue(DIRECTORY);
  h.api.startConferenceCall.mockReset().mockResolvedValue(CONFERENCE);
  h.toast.error.mockReset();
  h.session.call = null;
  h.session.enter.mockReset();
});

describe("GroupCallDialog", () => {
  it("renders nothing while closed", () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <GroupCallDialog open={false} onClose={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("needs two people: Call stays disabled for none or one, and says why", async () => {
    const { user } = renderDialog();

    expect(await screen.findByRole("button", { name: /Ada Lovelace/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Call/ })).toBeDisabled();
    expect(screen.getByText("Pick at least two people")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Ada Lovelace/ }));
    expect(screen.getByRole("button", { name: "Call 1" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /Grace Hopper/ }));
    expect(screen.getByRole("button", { name: "Call 2" })).toBeEnabled();
    expect(screen.queryByText("Pick at least two people")).toBeNull();
  });

  it("makes exactly ONE call for everyone picked and takes the caller into it", async () => {
    const { user, onClose } = renderDialog();

    await user.click(await screen.findByRole("button", { name: /Ada Lovelace/ }));
    await user.click(screen.getByRole("button", { name: /Grace Hopper/ }));
    await user.click(screen.getByRole("button", { name: /Linus Torvalds/ }));
    await user.click(screen.getByRole("button", { name: "Call 3" }));

    await waitFor(() => expect(h.session.enter).toHaveBeenCalled());
    expect(h.api.startConferenceCall).toHaveBeenCalledExactlyOnceWith([ADA.id, GRACE.id, LINUS.id], "video");
    expect(h.session.enter).toHaveBeenCalledExactlyOnceWith(CONFERENCE, undefined, "video");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the server's refusal and does not enter a room", async () => {
    h.api.startConferenceCall.mockRejectedValue(new Error("forbidden"));
    const { user, onClose } = renderDialog();

    await user.click(await screen.findByRole("button", { name: /Ada Lovelace/ }));
    await user.click(screen.getByRole("button", { name: /Grace Hopper/ }));
    await user.click(screen.getByRole("button", { name: "Call 2" }));

    await waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    expect(h.toast.error.mock.calls[0]![1]).toMatchObject({ description: "forbidden" });
    expect(h.session.enter).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("will not start a second call while already in a meeting or conference", async () => {
    h.session.call = CONFERENCE;
    const { user } = renderDialog();

    await user.click(await screen.findByRole("button", { name: /Ada Lovelace/ }));
    await user.click(screen.getByRole("button", { name: /Grace Hopper/ }));
    await user.click(screen.getByRole("button", { name: "Call 2" }));

    expect(h.toast.error).toHaveBeenCalledWith("You're already in a call");
    expect(h.api.startConferenceCall).not.toHaveBeenCalled();
  });
});
