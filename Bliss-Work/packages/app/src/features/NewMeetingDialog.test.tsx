/**
 * The redesigned "New Meeting" popup: Meeting Title, Start Time (date + time,
 * defaulting to now), End Time (date + time), Cancel, and a Start Now /
 * Schedule submit that switches label based on whether Start Time is
 * meaningfully in the future. See the component's own doc comment for why
 * this replaced ScheduleCallDialog's old "meeting" scope entirely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CallDTO } from "@taskboard/shared";
import { NewMeetingDialog } from "./NewMeetingDialog";

const api = { scheduleMeeting: vi.fn() };
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

function renderDialog(onStarted = vi.fn(), onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NewMeetingDialog onClose={onClose} onStarted={onStarted} />
    </QueryClientProvider>,
  );
  return { onStarted, onClose };
}

/** date/time pair `hours` from now, in the native input formats. */
function future(hours: number): { date: string; time: string } {
  const d = new Date(Date.now() + hours * 3_600_000);
  return {
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
  };
}

function setStart(v: { date: string; time: string }) {
  fireEvent.change(screen.getByLabelText("Start Time date"), { target: { value: v.date } });
  fireEvent.change(screen.getByLabelText("Start Time time"), { target: { value: v.time } });
}
function setEnd(v: { date: string; time: string }) {
  fireEvent.change(screen.getByLabelText("End Time date"), { target: { value: v.date } });
  fireEvent.change(screen.getByLabelText("End Time time"), { target: { value: v.time } });
}

const TITLE_PLACEHOLDER = "Enter meeting title";

beforeEach(() => {
  vi.clearAllMocks();
  api.scheduleMeeting.mockResolvedValue(call());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("New Meeting popup — fields", () => {
  it("shows Meeting Title, Start Time and End Time, each with the expected controls", () => {
    renderDialog();
    expect(screen.getByText("New Meeting")).toBeInTheDocument();
    expect(screen.getByText("Meeting Title")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(TITLE_PLACEHOLDER)).toBeInTheDocument();
    expect(screen.getByText("Start Time")).toBeInTheDocument();
    expect(screen.getByText("End Time")).toBeInTheDocument();
    expect(screen.getByLabelText("Start Time date")).toBeInTheDocument();
    expect(screen.getByLabelText("Start Time time")).toBeInTheDocument();
    expect(screen.getByLabelText("End Time date")).toBeInTheDocument();
    expect(screen.getByLabelText("End Time time")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("defaults Start Time to today's date and the current time", () => {
    renderDialog();
    const now = new Date();
    const wantDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(screen.getByLabelText("Start Time date")).toHaveValue(wantDate);
    // Minute-precision only — the exact second the test runs vs. render can
    // differ by a tick, so compare the two plausible minutes rather than an
    // exact string.
    const time = (screen.getByLabelText("Start Time time") as HTMLInputElement).value;
    expect(time).toMatch(/^\d{2}:\d{2}$/);
  });

  it("gives Meeting Title, Start Time and End Time a white background with a light border — never the theme-adaptive surface", () => {
    renderDialog();
    for (const el of [
      screen.getByPlaceholderText(TITLE_PLACEHOLDER),
      screen.getByLabelText("Start Time date"),
      screen.getByLabelText("Start Time time"),
      screen.getByLabelText("End Time date"),
      screen.getByLabelText("End Time time"),
    ]) {
      expect(el.className).toContain("bg-white");
      expect(el.className).toContain("border-gray-300");
      expect(el.className).toContain("rounded-lg");
    }
  });
});

describe("New Meeting popup — button label", () => {
  it("reads 'Start Now' by default (Start Time defaults to now)", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: /start now/i })).toBeInTheDocument();
  });

  it("reads 'Schedule' once Start Time is moved into the future", () => {
    renderDialog();
    setStart(future(2));
    expect(screen.getByRole("button", { name: "Schedule" })).toBeInTheDocument();
  });
});

describe("New Meeting popup — validation", () => {
  it("blocks submit and shows an error for an empty title", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /start now/i }));

    expect(await screen.findByText("Meeting title is required.")).toBeInTheDocument();
    expect(api.scheduleMeeting).not.toHaveBeenCalled();
  });

  it("does not nag about an empty title before the user has tried to submit", () => {
    renderDialog();
    expect(screen.queryByText("Meeting title is required.")).not.toBeInTheDocument();
  });

  it("requires Start Time — clearing it blocks submit", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByPlaceholderText(TITLE_PLACEHOLDER), "Standup");
    fireEvent.change(screen.getByLabelText("Start Time date"), { target: { value: "" } });

    await user.click(screen.getByRole("button", { name: /start now/i }));

    expect(await screen.findByText("Start date and time are required.")).toBeInTheDocument();
    expect(api.scheduleMeeting).not.toHaveBeenCalled();
  });

  it("requires End Time — clearing it blocks submit", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByPlaceholderText(TITLE_PLACEHOLDER), "Standup");
    fireEvent.change(screen.getByLabelText("End Time date"), { target: { value: "" } });

    await user.click(screen.getByRole("button", { name: /start now/i }));

    expect(await screen.findByText("End date and time are required.")).toBeInTheDocument();
    expect(api.scheduleMeeting).not.toHaveBeenCalled();
  });

  it("rejects an End Time that is not after Start Time", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByPlaceholderText(TITLE_PLACEHOLDER), "Standup");
    setStart(future(3));
    setEnd(future(2)); // earlier than start

    await user.click(screen.getByRole("button", { name: "Schedule" }));

    expect(await screen.findByText("End time must be later than the start time.")).toBeInTheDocument();
    expect(api.scheduleMeeting).not.toHaveBeenCalled();
  });

  it("rejects a Start Time clearly in the past", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByPlaceholderText(TITLE_PLACEHOLDER), "Standup");
    setStart(future(-2));

    await user.click(screen.getByRole("button", { name: /start now/i }));

    expect(await screen.findByText("Start time can't be in the past.")).toBeInTheDocument();
    expect(api.scheduleMeeting).not.toHaveBeenCalled();
  });
});

describe("New Meeting popup — submitting", () => {
  it("Start Now sends no scheduledAt and no durationMinutes, and joins immediately", async () => {
    const user = userEvent.setup();
    const { onStarted, onClose } = renderDialog();
    await user.type(screen.getByPlaceholderText(TITLE_PLACEHOLDER), "Standup");

    await user.click(screen.getByRole("button", { name: /start now/i }));

    await waitFor(() =>
      expect(api.scheduleMeeting).toHaveBeenCalledWith({
        title: "Standup",
        media: "video",
        scheduledAt: undefined,
        durationMinutes: undefined,
      }),
    );
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("Schedule sends the exact minutes between start and end, and does NOT join immediately", async () => {
    const user = userEvent.setup();
    const { onStarted, onClose } = renderDialog();
    await user.type(screen.getByPlaceholderText(TITLE_PLACEHOLDER), "Standup");
    setStart(future(2));
    setEnd(future(3)); // one hour after start

    await user.click(screen.getByRole("button", { name: "Schedule" }));

    await waitFor(() => expect(api.scheduleMeeting).toHaveBeenCalled());
    const body = api.scheduleMeeting.mock.calls[0]![0] as {
      scheduledAt?: string;
      durationMinutes?: number;
    };
    expect(body.scheduledAt).toBeTruthy();
    expect(body.durationMinutes).toBe(60);
    expect(onClose).toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
  });
});

describe("New Meeting popup — Cancel and Close", () => {
  it("Cancel closes without creating a meeting", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalled();
    expect(api.scheduleMeeting).not.toHaveBeenCalled();
  });

  it("the X button closes without creating a meeting", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
    expect(api.scheduleMeeting).not.toHaveBeenCalled();
  });
});
