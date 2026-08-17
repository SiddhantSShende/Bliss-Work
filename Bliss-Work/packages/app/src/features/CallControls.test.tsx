/**
 * The in-call surface's two new pieces: the control row, and the sharing panel.
 *
 * Both are specified by behaviour rather than by looks, and both have a rule
 * that is easy to break by accident later — the row is FIVE controls and no
 * more, and the panel can be slid away but never dismissed.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CallControls } from "./CallControls";
import { ScreenSharePopup } from "./ScreenSharePopup";
import { formatCallDuration } from "../lib/callTimer";

function controls(props: Partial<Parameters<typeof CallControls>[0]> = {}) {
  const handlers = {
    onAddPeople: vi.fn(),
    onToggleShare: vi.fn(),
    onToggleMic: vi.fn(),
    onToggleCam: vi.fn(),
    onEnd: vi.fn(),
  };
  render(<CallControls micOn camOn={false} sharing={false} {...handlers} {...props} />);
  return handlers;
}

describe("CallControls", () => {
  it("offers five controls and nothing else", () => {
    controls();
    expect(screen.getAllByRole("button")).toHaveLength(5);
    for (const name of ["Add people", "Share your screen", "Mute", "Turn camera on", "End call"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("offers the camera on a voice call too", () => {
    // A voice call is a call whose camera happens to be off, not a call with
    // one fewer control — the media session reserves a video slot for exactly
    // this.
    controls({ camOn: false });
    expect(screen.getByRole("button", { name: "Turn camera on" })).toBeEnabled();
  });

  it("keeps Add People in place, disabled, when the call cannot be widened", () => {
    // Disabled rather than removed: the row must not change shape under a
    // moving cursor, and End Call must always be the fifth button.
    controls({ canAddPeople: false, addPeopleTitle: "Everyone is already invited" });
    expect(screen.getAllByRole("button")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Everyone is already invited" })).toBeDisabled();
  });

  it("shows no clock at all when nothing is being shared", () => {
    // Not cosmetic. The duration hook keeps a 1s interval alive for as long as
    // it has a start time, and this row is mounted for the whole call — so a
    // clock nobody can see is five buttons re-rendering every second, all call.
    controls({ sharing: false, startedAt: Date.now() - 65_000 });
    for (const b of screen.getAllByRole("button")) {
      expect(b.textContent).not.toMatch(/\d+:\d\d/);
    }
  });

  it("turns the share control into a red, ticking indicator while sharing", () => {
    const startedAt = Date.now() - 65_000;
    controls({ sharing: true, startedAt });
    const share = screen.getByRole("button", { name: "Stop sharing your screen" });
    expect(share).toHaveAttribute("aria-pressed", "true");
    expect(share.className).toContain("text-red-500");
    expect(share).toHaveTextContent("1:05");
  });

  it("reports each press to its own handler", async () => {
    const user = userEvent.setup();
    const h = controls();
    await user.click(screen.getByRole("button", { name: "Add people" }));
    await user.click(screen.getByRole("button", { name: "Share your screen" }));
    await user.click(screen.getByRole("button", { name: "Mute" }));
    await user.click(screen.getByRole("button", { name: "End call" }));
    expect(h.onAddPeople).toHaveBeenCalledOnce();
    expect(h.onToggleShare).toHaveBeenCalledOnce();
    expect(h.onToggleMic).toHaveBeenCalledOnce();
    expect(h.onEnd).toHaveBeenCalledOnce();
    expect(h.onToggleCam).not.toHaveBeenCalled();
  });
});

describe("ScreenSharePopup", () => {
  it("says a share is running and offers the only stop control there is", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(<ScreenSharePopup onStop={onStop} startedAt={Date.now()} />);
    expect(screen.getByRole("status")).toHaveTextContent("You're sharing your screen");
    await user.click(screen.getByRole("button", { name: "Stop sharing" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("slides away to a side icon, and comes back from it", async () => {
    const user = userEvent.setup();
    render(<ScreenSharePopup onStop={vi.fn()} startedAt={Date.now()} />);

    await user.click(screen.getByRole("button", { name: "Slide out of the way" }));
    // findBy, not getBy: the panel slides out before the tab slides in, so the
    // swap is not synchronous.
    const tab = await screen.findByRole("button", { name: "Show screen sharing controls" });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());

    await user.click(tab);
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("has no way to dismiss it — a share you forgot is the thing to prevent", () => {
    render(<ScreenSharePopup onStop={vi.fn()} startedAt={Date.now()} />);
    expect(screen.queryByRole("button", { name: /close|dismiss/i })).not.toBeInTheDocument();
  });
});

describe("formatCallDuration", () => {
  it("counts in m:ss, and grows an hours field only when there is one", () => {
    expect(formatCallDuration(0)).toBe("0:00");
    expect(formatCallDuration(9_000)).toBe("0:09");
    expect(formatCallDuration(65_000)).toBe("1:05");
    expect(formatCallDuration(3_600_000)).toBe("1:00:00");
    expect(formatCallDuration(3_725_000)).toBe("1:02:05");
  });

  it("never shows a negative clock when the two ends disagree about now", () => {
    expect(formatCallDuration(-5_000)).toBe("0:00");
  });
});
