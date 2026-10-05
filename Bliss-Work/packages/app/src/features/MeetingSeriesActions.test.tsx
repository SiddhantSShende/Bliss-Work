/**
 * Edit and cancel for a repeating meeting: who is offered them, and what cancelling
 * actually asks and does. The real component and the real edit dialog run; only the
 * api is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { CallDTO } from "@taskboard/shared";
import { toast } from "sonner";
import { useSession } from "../store/session";
import { CHANNELS, DIRECTORY, ME, OCCURRENCE, SERIES } from "../test/meetingFixtures";

const h = vi.hoisted(() => ({
  api: {
    cancelMeetingSeries: vi.fn(),
    meetingSeries: vi.fn(),
    updateMeetingSeries: vi.fn(),
    directory: vi.fn(),
    channels: vi.fn(),
  },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { MeetingSeriesActions } from "./MeetingSeriesActions";

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

let qc: QueryClient;
function renderActions(call: CallDTO) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/app/meetings/abc"]}>
        <MeetingSeriesActions call={call} />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const editBtn = () => screen.queryByRole("button", { name: "Edit series" });
const cancelBtn = () => screen.queryByRole("button", { name: "Cancel series" });

beforeEach(() => {
  useSession.setState({ user: ME });
  h.api.cancelMeetingSeries.mockReset().mockResolvedValue(undefined);
  h.api.meetingSeries.mockReset().mockResolvedValue(SERIES);
  h.api.directory.mockReset().mockResolvedValue(DIRECTORY);
  h.api.channels.mockReset().mockResolvedValue(CHANNELS);
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.success).mockReset();
});

describe("who is offered them", () => {
  it("the organiser of a repeating meeting: both", () => {
    renderActions(OCCURRENCE);
    expect(editBtn()).toBeInTheDocument();
    expect(cancelBtn()).toBeInTheDocument();
  });

  it("a completed series can still be edited or cancelled — its last meetings may be upcoming", () => {
    renderActions({ ...OCCURRENCE, series: { ...OCCURRENCE.series!, status: "COMPLETED" } });
    expect(editBtn()).toBeInTheDocument();
    expect(cancelBtn()).toBeInTheDocument();
  });

  it("nobody else, whatever their seat on the roster", () => {
    renderActions({ ...OCCURRENCE, createdBy: "00000000-0000-4000-8000-000000000099" });
    expect(editBtn()).not.toBeInTheDocument();
    expect(cancelBtn()).not.toBeInTheDocument();
  });

  it("not for a one-off meeting — there is no series to act on", () => {
    renderActions({ ...OCCURRENCE, series: null });
    expect(editBtn()).not.toBeInTheDocument();
    expect(cancelBtn()).not.toBeInTheDocument();
  });

  it("not for a series that was cancelled", () => {
    renderActions({ ...OCCURRENCE, series: { ...OCCURRENCE.series!, status: "CANCELLED" } });
    expect(editBtn()).not.toBeInTheDocument();
    expect(cancelBtn()).not.toBeInTheDocument();
  });
});

describe("edit", () => {
  it("opens the edit dialog for the SERIES, not the occurrence", async () => {
    const user = renderActions(OCCURRENCE);
    await user.click(editBtn()!);
    expect(await screen.findByRole("dialog", { name: "Edit repeating meeting" })).toBeInTheDocument();
    expect(h.api.meetingSeries).toHaveBeenCalledWith(SERIES.id);
  });

  it("closes again", async () => {
    const user = renderActions(OCCURRENCE);
    await user.click(editBtn()!);
    await user.click(await screen.findByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Edit repeating meeting" })).not.toBeInTheDocument();
  });
});

describe("cancel", () => {
  it("asks first, and says it is the whole series and that the past is kept", async () => {
    const user = renderActions(OCCURRENCE);
    await user.click(cancelBtn()!);
    const dialog = await screen.findByRole("dialog", { name: "Cancel this series?" });
    expect(dialog).toHaveTextContent("Every upcoming meeting in this series will be removed for everyone");
    expect(dialog).toHaveTextContent("Meetings that already happened are kept");
    expect(h.api.cancelMeetingSeries).not.toHaveBeenCalled();
  });

  it("backing out cancels nothing", async () => {
    const user = renderActions(OCCURRENCE);
    await user.click(cancelBtn()!);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(h.api.cancelMeetingSeries).not.toHaveBeenCalled();
    // The modal animates out, so it leaves the document a moment later.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Cancel this series?" })).not.toBeInTheDocument(),
    );
  });

  it("confirming cancels the series, refreshes the lists, and leaves the removed meeting's page", async () => {
    const user = renderActions(OCCURRENCE);
    const spy = vi.spyOn(qc, "invalidateQueries");
    await user.click(cancelBtn()!);
    const dialog = await screen.findByRole("dialog", { name: "Cancel this series?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel series" }));

    await waitFor(() => expect(h.api.cancelMeetingSeries).toHaveBeenCalledWith(SERIES.id));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/meetings"));
    expect(screen.getByTestId("where")).not.toHaveTextContent("/abc");
    expect(spy).toHaveBeenCalledWith({ queryKey: ["calls"] });
    expect(toast.success).toHaveBeenCalledWith("Series cancelled");
  });

  it("a failure says so, stays where it is, and does not pretend", async () => {
    h.api.cancelMeetingSeries.mockRejectedValue(new Error("nope"));
    const user = renderActions(OCCURRENCE);
    await user.click(cancelBtn()!);
    const dialog = await screen.findByRole("dialog", { name: "Cancel this series?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel series" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't cancel the series"));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByTestId("where")).toHaveTextContent("/app/meetings/abc");
  });
});
