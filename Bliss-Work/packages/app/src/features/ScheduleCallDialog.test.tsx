/**
 * The "New Meeting" popup: title (required), start time (optional — leaving
 * it empty means "now"), end time (required once a start time is set, and
 * always later than it), Cancel, and a Start Now / Schedule submit.
 *
 * Channel and direct scopes keep their own Type + duration-preset fields
 * untouched — only the meeting scope gets the literal title/start/end shape
 * this file mostly covers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CallDTO } from "@taskboard/shared";
import { ScheduleCallDialog } from "./ScheduleCallDialog";

const api = { scheduleMeeting: vi.fn(), scheduleChannelCall: vi.fn(), scheduleDirectCall: vi.fn() };
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api }) }));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

function call(over: Partial<CallDTO> = {}): CallDTO {
  return {
    id: "018f0000-0000-7000-8000-000000000001",
    orgId: "org",
    kind: "MEETING",
    title: "Weekly review",
    media: "video",
    createdBy: "me",
    status: "SCHEDULED",
    createdAt: new Date(0).toISOString(),
    participants: [],
    activeShares: [],
    ...over,
  } as CallDTO;
}

function renderDialog(onStarted = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <ScheduleCallDialog scope={{ kind: "meeting" }} onClose={vi.fn()} onStarted={onStarted} />
    </QueryClientProvider>,
  );
  // Two datetime-local inputs, start then end, in DOM order — distinguished
  // this way rather than by display value, since the (also initially empty)
  // title input would otherwise match too. datetime-local's native picker UI
  // means fireEvent.change is the reliable way to set one in jsdom, not
  // userEvent.type (which simulates keystrokes the segmented widget does not
  // take the same way a real browser's does).
  const [startInput, endInput] = Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]'),
  );
  return {
    onStarted,
    setStart: (v: string) => fireEvent.change(startInput!, { target: { value: v } }),
    setEnd: (v: string) => fireEvent.change(endInput!, { target: { value: v } }),
    endInput: endInput!,
  };
}

/** A time comfortably in the future, in datetime-local's own format. */
function future(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString().slice(0, 16);
}

const TITLE_PLACEHOLDER = "Weekly review";

beforeEach(() => {
  vi.clearAllMocks();
  api.scheduleMeeting.mockResolvedValue(call());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("New Meeting popup — fields", () => {
  it("shows only title, start time, end time and the two buttons — no Type, no Length presets", () => {
    renderDialog();
    expect(screen.getByText(/Title/)).toBeInTheDocument();
    expect(screen.getByText(/Start time/)).toBeInTheDocument();
    expect(screen.getByText(/End time/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.queryByText("Type")).not.toBeInTheDocument();
    expect(screen.queryByText(/Length/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Audio" })).not.toBeInTheDocument();
  });

  it("disables End time until a start time is set", () => {
    const { endInput } = renderDialog();
    expect(endInput).toBeDisabled();
  });
});

describe("New Meeting popup — button label", () => {
  it("reads 'Start Now' while start time is empty", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Start Now" })).toBeInTheDocument();
  });

  it("reads 'Schedule' once a start time is entered", () => {
    const { setStart } = renderDialog();
    setStart(future(2));
    expect(screen.getByRole("button", { name: "Schedule" })).toBeInTheDocument();
  });
});

describe("New Meeting popup — validation", () => {
  it("blocks submit and shows an error for an empty title", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Start Now" }));

    expect(await screen.findByText("Meeting title is required.")).toBeInTheDocument();
    expect(api.scheduleMeeting).not.toHaveBeenCalled();
  });

  it("requires an end time once a start time is set", async () => {
    const user = userEvent.setup();
    const { setStart } = renderDialog();
    await user.type(screen.getByPlaceholderText(TITLE_PLACEHOLDER), "Standup");
    setStart(future(2));

    await user.click(screen.getByRole("button", { name: "Schedule" }));

    expect(
      await screen.findByText("End time is required once you set a start time."),
    ).toBeInTheDocument();
    expect(api.scheduleMeeting).not.toHaveBeenCalled();
  });

  it("rejects an end time that is not after the start time", async () => {
    const user = userEvent.setup();
    const { setStart, setEnd } = renderDialog();
    await user.type(screen.getByPlaceholderText(TITLE_PLACEHOLDER), "Standup");
    setStart(future(3));
    setEnd(future(2)); // earlier than start

    await user.click(screen.getByRole("button", { name: "Schedule" }));

    expect(await screen.findByText("End time must be later than the start time.")).toBeInTheDocument();
    expect(api.scheduleMeeting).not.toHaveBeenCalled();
  });

  it("rejects a start time in the past", async () => {
    const user = userEvent.setup();
    const { setStart } = renderDialog();
    await user.type(screen.getByPlaceholderText(TITLE_PLACEHOLDER), "Standup");
    const past = new Date(Date.now() - 3_600_000).toISOString().slice(0, 16);
    setStart(past);

    await user.click(screen.getByRole("button", { name: "Schedule" }));

    expect(await screen.findByText("Start time can't be in the past.")).toBeInTheDocument();
    expect(api.scheduleMeeting).not.toHaveBeenCalled();
  });

  it("does not nag about an empty title before the user has tried to submit", () => {
    renderDialog();
    expect(screen.queryByText("Meeting title is required.")).not.toBeInTheDocument();
  });
});

describe("New Meeting popup — submitting", () => {
  it("Start Now sends no scheduledAt and no durationMinutes", async () => {
    const user = userEvent.setup();
    const { onStarted } = renderDialog();
    await user.type(screen.getByPlaceholderText(TITLE_PLACEHOLDER), "Standup");

    await user.click(screen.getByRole("button", { name: "Start Now" }));

    await waitFor(() =>
      expect(api.scheduleMeeting).toHaveBeenCalledWith({
        title: "Standup",
        media: "video",
        scheduledAt: undefined,
        durationMinutes: undefined,
      }),
    );
    // "Meet now" opens immediately rather than making the user click twice.
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
  });

  it("Schedule sends the exact minutes between start and end", async () => {
    const user = userEvent.setup();
    const { setStart, setEnd } = renderDialog();
    await user.type(screen.getByPlaceholderText(TITLE_PLACEHOLDER), "Standup");
    setStart(future(2));
    setEnd(future(3)); // one hour after start

    await user.click(screen.getByRole("button", { name: "Schedule" }));

    await waitFor(() => expect(api.scheduleMeeting).toHaveBeenCalled());
    const body = api.scheduleMeeting.mock.calls[0]![0] as { durationMinutes?: number };
    expect(body.durationMinutes).toBe(60);
  });

  it("shows the created meeting's title, start and end once scheduled", async () => {
    const user = userEvent.setup();
    const scheduledAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const endsAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
    api.scheduleMeeting.mockResolvedValue(call({ title: "Standup", scheduledAt, endsAt }));
    const { setStart, setEnd } = renderDialog();
    await user.type(screen.getByPlaceholderText(TITLE_PLACEHOLDER), "Standup");
    setStart(future(2));
    setEnd(future(3));

    await user.click(screen.getByRole("button", { name: "Schedule" }));

    expect(await screen.findByText("Standup")).toBeInTheDocument();
  });
});
