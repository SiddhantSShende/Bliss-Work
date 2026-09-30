/**
 * The "Meeting Scheduled!" confirmation on its own: the real join link (minted
 * through the same api.createCallInvite every in-room invite control uses),
 * Copy Link, View in Calendar, Start Meeting Now, and the two ways to close
 * (the shell's own X and the footer's own Close) — this dialog owns closing
 * itself, independent of whatever the caller's own handler does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OCCURRENCE } from "../test/meetingFixtures";

const h = vi.hoisted(() => ({ api: { createCallInvite: vi.fn() } }));
vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: h.api, config: { webBaseUrl: "https://app.test" } }),
}));

import { MeetingScheduledDialog } from "./MeetingScheduledDialog";

const onClose = vi.fn();
const onStarted = vi.fn();
const onViewInCalendar = vi.fn();

const setClipboardApi = (writeText: ((text: string) => Promise<void>) | undefined) => {
  Object.defineProperty(navigator, "clipboard", {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
};

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MeetingScheduledDialog
        call={OCCURRENCE}
        title="Design sync"
        startAt={new Date(2026, 8, 15, 14, 0)}
        endAt={new Date(2026, 8, 15, 15, 0)}
        inviteeNames={["Ada Lovelace"]}
        channelNames={["general"]}
        onClose={onClose}
        onStarted={onStarted}
        onViewInCalendar={onViewInCalendar}
      />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  h.api.createCallInvite
    .mockReset()
    .mockResolvedValue({ id: "invite-1", callId: OCCURRENCE.id, token: "tok_abc", expiresAt: "2026-09-16T10:00:00.000Z" });
  onClose.mockReset();
  onStarted.mockReset();
  onViewInCalendar.mockReset();
  setClipboardApi(undefined);
});

describe("MeetingScheduledDialog", () => {
  it("shows the meeting details and mints the real join link on its own", async () => {
    renderDialog();

    expect(screen.getByRole("heading", { name: "Meeting Scheduled!" })).toBeInTheDocument();
    expect(screen.getByText("Design sync")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace, #general")).toBeInTheDocument();
    expect(await screen.findByText("https://app.test/join?t=tok_abc")).toBeInTheDocument();
    expect(h.api.createCallInvite).toHaveBeenCalledWith(OCCURRENCE.id);
  });

  it("Copy Link copies the real link", async () => {
    const user = renderDialog();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboardApi(writeText);
    await screen.findByText("https://app.test/join?t=tok_abc");

    await user.click(screen.getByRole("button", { name: "Copy Link" }));

    expect(writeText).toHaveBeenCalledWith("https://app.test/join?t=tok_abc");
    expect(await screen.findByText("Copied!")).toBeInTheDocument();
  });

  it("Start Meeting Now fires onStarted with the call and closes", async () => {
    const user = renderDialog();
    await user.click(screen.getByRole("button", { name: "Start Meeting Now" }));

    expect(onStarted).toHaveBeenCalledWith(OCCURRENCE);
    expect(onClose).toHaveBeenCalled();
    expect(onViewInCalendar).not.toHaveBeenCalled();
  });

  it("View in Calendar fires onViewInCalendar with the call and closes", async () => {
    const user = renderDialog();
    await user.click(screen.getByRole("button", { name: "View in Calendar" }));

    expect(onViewInCalendar).toHaveBeenCalledWith(OCCURRENCE);
    expect(onClose).toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("the footer's Close dismisses without starting or navigating", async () => {
    const user = renderDialog();
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    expect(onViewInCalendar).not.toHaveBeenCalled();
  });

  it("the shell's own X also dismisses", async () => {
    const user = renderDialog();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onClose).toHaveBeenCalled();
  });
});
