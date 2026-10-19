/**
 * The optional Deadline in the New task form: no deadline changes nothing, an
 * absolute deadline rides on an instant or scheduled task, and a recurring task
 * carries a RULE (relative or fixed time) rather than a timestamp. The rest of the
 * form (assign-to, allocation cards, the analog clock) is covered by
 * CreateTaskDialog.test.tsx and must stay exactly as it is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "../store/session";
import { ADA, CHANNELS, DIRECTORY, ME } from "../test/meetingFixtures";
import { pagedChannels, pagedDirectory } from "../test/pagedPickerApi";
import { setClockTime } from "../test/timePicker";

const h = vi.hoisted(() => ({
  api: { createTask: vi.fn(), directoryPage: vi.fn(), channelsPage: vi.fn(), projects: vi.fn() },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";
import { CreateTaskDialog } from "./CreateTaskDialog";

const OPENED_AT = new Date(2026, 8, 15, 10, 0, 0); // Tue 15 Sep 2026, 10:00
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function openDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CreateTaskDialog open onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

function sent() {
  expect(h.api.createTask).toHaveBeenCalledTimes(1);
  return h.api.createTask.mock.calls[0]![0] as Record<string, any>;
}

async function readyToSend(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: /^People/ }));
  await user.click(await screen.findByRole("checkbox", { name: /Ada Lovelace/ }));
}

const deadlineKind = () => screen.getByLabelText("Deadline", { selector: "select" }) as HTMLSelectElement;
const create = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Create Task" }));
const optionsOf = (select: HTMLSelectElement) => [...select.options].map((o) => o.textContent);

async function recurringFrom(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: /Recurring task/ }));
  fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-09-16" } });
  await setClockTime(user, "Start time", 9, 0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(OPENED_AT);
  useSession.setState({ user: ME });
  h.api.createTask.mockReset().mockResolvedValue({ taskId: "task-1" });
  h.api.projects.mockReset().mockResolvedValue([]);
  h.api.directoryPage.mockReset().mockImplementation(pagedDirectory(DIRECTORY));
  h.api.channelsPage.mockReset().mockImplementation(pagedChannels(CHANNELS));
  vi.mocked(toast.error).mockReset();
});
afterEach(() => vi.useRealTimers());

describe("no deadline", () => {
  it("is the default, for every allocation, and the request carries nothing about one", async () => {
    const user = openDialog();
    expect(deadlineKind().value).toBe("NONE");
    await readyToSend(user);
    await create(user);

    const body = sent();
    expect(body).not.toHaveProperty("deadlineAt");
    expect(body.recurrence).toBeUndefined();
    expect(Object.keys(body).sort()).toEqual(["allocation", "assigneeIds", "description"]);
  });

  it("a recurring task without one sends a recurrence with no `deadline`", async () => {
    const user = openDialog();
    await readyToSend(user);
    await recurringFrom(user);
    await create(user);
    expect(sent().recurrence).not.toHaveProperty("deadline");
  });
});

describe("the control follows the allocation", () => {
  it("offers a date & time for a one-off task, and a relative or fixed rule for a series", async () => {
    const user = openDialog();
    expect(optionsOf(deadlineKind())).toEqual(["No deadline", "Date & time"]);

    await user.click(screen.getByRole("radio", { name: /Schedule for later/ }));
    expect(optionsOf(deadlineKind())).toEqual(["No deadline", "Date & time"]);

    await user.click(screen.getByRole("radio", { name: /Recurring task/ }));
    expect(optionsOf(deadlineKind())).toEqual(["No deadline", "Relative", "Fixed time"]);
  });

  it("drops a deadline that makes no sense for the allocation it was switched to", async () => {
    const user = openDialog();
    await readyToSend(user);
    await user.selectOptions(deadlineKind(), "AT");
    fireEvent.change(screen.getByLabelText("Deadline date"), { target: { value: "2026-09-20" } });
    await setClockTime(user, "Deadline time", 16, 0);

    await user.click(screen.getByRole("radio", { name: /Recurring task/ }));
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-09-16" } });
    await setClockTime(user, "Start time", 9, 0);
    expect(deadlineKind().value).toBe("NONE"); // an absolute date has no meaning for a series
    await create(user);
    const body = sent();
    expect(body).not.toHaveProperty("deadlineAt");
    expect(body.recurrence).not.toHaveProperty("deadline");
  });
});

describe("an absolute deadline", () => {
  it("on an instant task is sent as deadlineAt, local date and time with the UTC offset", async () => {
    const user = openDialog();
    await readyToSend(user);
    await user.selectOptions(deadlineKind(), "AT");
    fireEvent.change(screen.getByLabelText("Deadline date"), { target: { value: "2026-09-20" } });
    await setClockTime(user, "Deadline time", 16, 30);
    await create(user);

    const body = sent();
    expect(body.allocation).toBe("NOW");
    expect(body.deadlineAt).toMatch(/^2026-09-20T16:30:00[+-]\d\d:\d\d$/);
    expect(new Date(body.deadlineAt).getTime()).toBe(new Date(2026, 8, 20, 16, 30).getTime());
  });

  it("on a scheduled task rides alongside scheduledFor", async () => {
    const user = openDialog();
    await readyToSend(user);
    await user.click(screen.getByRole("radio", { name: /Schedule for later/ }));
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-09-16" } });
    await setClockTime(user, "Start time", 9, 0);
    await user.selectOptions(deadlineKind(), "AT");
    fireEvent.change(screen.getByLabelText("Deadline date"), { target: { value: "2026-09-16" } });
    await setClockTime(user, "Deadline time", 17, 0);
    await create(user);

    const body = sent();
    expect(body.allocation).toBe("SCHEDULED");
    expect(new Date(body.scheduledFor).getTime()).toBe(new Date(2026, 8, 16, 9, 0).getTime());
    expect(new Date(body.deadlineAt).getTime()).toBe(new Date(2026, 8, 16, 17, 0).getTime());
  });

  it("is refused until it has a date and a time, and when it is not in the future", async () => {
    const user = openDialog();
    await readyToSend(user);
    await user.selectOptions(deadlineKind(), "AT");
    await create(user);
    expect(toast.error).toHaveBeenLastCalledWith("Choose a deadline date and time");

    fireEvent.change(screen.getByLabelText("Deadline date"), { target: { value: "2026-09-15" } });
    await setClockTime(user, "Deadline time", 9, 0); // today, but before "now" (10:00)
    await create(user);
    expect(toast.error).toHaveBeenLastCalledWith("The deadline must be in the future");
    expect(h.api.createTask).not.toHaveBeenCalled();
  });

  it("on a scheduled task is refused when it is not after the scheduled time", async () => {
    const user = openDialog();
    await readyToSend(user);
    await user.click(screen.getByRole("radio", { name: /Schedule for later/ }));
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-09-16" } });
    await setClockTime(user, "Start time", 9, 0);
    await user.selectOptions(deadlineKind(), "AT");
    fireEvent.change(screen.getByLabelText("Deadline date"), { target: { value: "2026-09-16" } });
    await setClockTime(user, "Deadline time", 8, 0);
    await create(user);
    expect(toast.error).toHaveBeenLastCalledWith("The deadline must be after the task is scheduled");
    expect(h.api.createTask).not.toHaveBeenCalled();
  });
});

describe("a recurring task's deadline rule", () => {
  it("relative: 'N unit after each occurrence', with the browser's IANA zone", async () => {
    const user = openDialog();
    await readyToSend(user);
    await recurringFrom(user);
    await user.selectOptions(deadlineKind(), "RELATIVE");
    expect(screen.getByText("after each occurrence")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Deadline amount"), { target: { value: "6" } });
    await user.selectOptions(screen.getByLabelText("Deadline unit"), "HOURS");
    await create(user);

    expect(sent().recurrence.deadline).toEqual({ kind: "RELATIVE", amount: 6, unit: "HOURS", timeZone: ZONE });
    expect(sent()).not.toHaveProperty("deadlineAt");
  });

  it("relative offers minutes, hours and days", async () => {
    const user = openDialog();
    await recurringFrom(user);
    await user.selectOptions(deadlineKind(), "RELATIVE");
    expect(optionsOf(screen.getByLabelText("Deadline unit") as HTMLSelectElement)).toEqual(["Minutes", "Hours", "Days"]);
  });

  it("fixed time: that time of day on each occurrence's date", async () => {
    const user = openDialog();
    await readyToSend(user);
    await recurringFrom(user);
    await user.selectOptions(deadlineKind(), "FIXED");
    expect(screen.getByText("on each occurrence's date")).toBeInTheDocument();
    await setClockTime(user, "Deadline time", 17, 0);
    await create(user);

    expect(sent().recurrence.deadline).toEqual({ kind: "FIXED_TIME", time: "17:00", timeZone: ZONE });
  });

  it("refuses a missing or non-whole amount, and a fixed time not later than the start", async () => {
    const user = openDialog();
    await readyToSend(user);
    await recurringFrom(user);

    await user.selectOptions(deadlineKind(), "RELATIVE");
    fireEvent.change(screen.getByLabelText("Deadline amount"), { target: { value: "" } });
    await create(user);
    expect(toast.error).toHaveBeenLastCalledWith("Enter a whole number for how long after each occurrence");

    await user.selectOptions(deadlineKind(), "FIXED");
    await create(user);
    expect(toast.error).toHaveBeenLastCalledWith("Choose a deadline time");

    await setClockTime(user, "Deadline time", 9, 0); // start is 09:00 — not later
    await create(user);
    expect(toast.error).toHaveBeenLastCalledWith("The fixed deadline time must be later than the start time");
    expect(h.api.createTask).not.toHaveBeenCalled();
  });
});

describe("the rest of the form is untouched", () => {
  it("keeps the title, description, assign-to panel and allocation cards", () => {
    openDialog();
    expect(screen.getByPlaceholderText(/Pick channels, people, or a project/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Assign to/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /People/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Channels/ })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    // the deadline sits after the allocation cards, inside the same form
    const form = document.querySelector("form")!;
    expect(within(form).getByTestId("deadline-field")).toBeInTheDocument();
    expect(ADA.id).toBeTruthy();
  });
});
