/**
 * Device activity consent screen — the macOS permission surface specifically:
 * app-name tracking degraded vs. window-title tracking degraded are DIFFERENT
 * facts (see main/macos-permissions.ts's docstring on what Screen Recording
 * does and does not gate) and must render as different messages, not one
 * generic "tracking unavailable" banner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const agent = {
  state: vi.fn(),
  setEnabled: vi.fn(),
  pair: vi.fn(),
  openScreenRecordingSettings: vi.fn(),
};
const api = { createAgentToken: vi.fn() };

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api, config: { kind: "desktop", activityAgent: agent } }),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { DeviceActivitySettings } from "./DeviceActivitySettings";
import { toast } from "sonner";

function macState(over: Partial<Awaited<ReturnType<typeof agent.state>>> = {}) {
  return {
    enabled: true,
    paired: true,
    appTracking: true,
    reason: null,
    titleTracking: true,
    titleTrackingReason: null,
    ...over,
  };
}

describe("DeviceActivitySettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows nothing extra when both app and title tracking work", async () => {
    agent.state.mockResolvedValue(macState());
    render(<DeviceActivitySettings />);
    await waitFor(() => expect(agent.state).toHaveBeenCalled());
    expect(screen.queryByText(/window titles are not yet/i)).toBeNull();
    expect(screen.queryByText(/application tracking isn't available/i)).toBeNull();
  });

  it("shows the NARROW title-only warning when app tracking works but Screen Recording is not granted", async () => {
    agent.state.mockResolvedValue(
      macState({ titleTracking: false, titleTrackingReason: "Screen Recording permission was denied" }),
    );
    render(<DeviceActivitySettings />);
    await waitFor(() =>
      expect(screen.getByText(/application names are recorded, but window titles are not yet/i)).toBeTruthy(),
    );
    // The BROADER "tracking isn't available at all" message must NOT also
    // show — app tracking is working, only titles are degraded.
    expect(screen.queryByText(/application tracking isn't available here/i)).toBeNull();
    expect(screen.getByText(/screen recording permission was denied/i)).toBeTruthy();
  });

  it("offers to open Screen Recording settings, and calls the bridge method on click", async () => {
    agent.state.mockResolvedValue(
      macState({ titleTracking: false, titleTrackingReason: "Screen Recording permission has not been requested yet" }),
    );
    agent.openScreenRecordingSettings.mockResolvedValue(true);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DeviceActivitySettings />);
    const button = await screen.findByRole("button", { name: /open screen recording settings/i });
    await user.click(button);
    expect(agent.openScreenRecordingSettings).toHaveBeenCalledTimes(1);
  });

  it("shows the BROAD warning, not the title-specific one, when app tracking itself is unavailable", async () => {
    agent.state.mockResolvedValue(
      macState({
        appTracking: false, reason: "app tracking is unavailable in this build",
        titleTracking: false, titleTrackingReason: "app tracking is unavailable in this build",
      }),
    );
    render(<DeviceActivitySettings />);
    await waitFor(() =>
      expect(screen.getByText(/application tracking isn't available here/i)).toBeTruthy(),
    );
    // Would be misleading here: it implies app tracking already works and
    // only titles are missing, which is false in this state.
    expect(screen.queryByText(/application names are recorded, but window titles/i)).toBeNull();
  });

  it("does not show the title warning before the device is paired", async () => {
    agent.state.mockResolvedValue(
      macState({ paired: false, enabled: false, titleTracking: false, titleTrackingReason: "Screen Recording permission has not been requested yet" }),
    );
    render(<DeviceActivitySettings />);
    await waitFor(() => expect(agent.state).toHaveBeenCalled());
    expect(screen.queryByText(/window titles are not yet/i)).toBeNull();
  });

  it("mentions the upcoming macOS permission prompt in the connect toast on a Mac build", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      configurable: true,
    });
    agent.state.mockResolvedValue(macState({ paired: false, enabled: false }));
    api.createAgentToken.mockResolvedValue({ token: "tok_test" });
    agent.pair.mockResolvedValue({ enabled: true, paired: true });
    agent.setEnabled.mockResolvedValue({ enabled: true, paired: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DeviceActivitySettings />);
    const button = await screen.findByRole("button", { name: /turn on for this device/i });
    await user.click(button);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const call = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0];
    const message = call?.[0];
    expect(message).toMatch(/screen recording/i);
  });

  it("does NOT mention Screen Recording in the connect toast on Windows", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      configurable: true,
    });
    agent.state.mockResolvedValue(macState({ paired: false, enabled: false }));
    api.createAgentToken.mockResolvedValue({ token: "tok_test" });
    agent.pair.mockResolvedValue({ enabled: true, paired: true });
    agent.setEnabled.mockResolvedValue({ enabled: true, paired: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DeviceActivitySettings />);
    const button = await screen.findByRole("button", { name: /turn on for this device/i });
    await user.click(button);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const call = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0];
    const message = call?.[0];
    expect(message).not.toMatch(/screen recording/i);
  });

  it("re-checks state periodically while mounted, so a REVOKED permission is discovered without leaving the screen", async () => {
    agent.state.mockResolvedValue(macState());
    render(<DeviceActivitySettings />);
    await waitFor(() => expect(agent.state).toHaveBeenCalledTimes(1));

    agent.state.mockResolvedValue(
      macState({ titleTracking: false, titleTrackingReason: "Screen Recording permission was denied" }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await waitFor(() =>
      expect(screen.getByText(/application names are recorded, but window titles are not yet/i)).toBeTruthy(),
    );
  });

  it("stops polling after unmount", async () => {
    agent.state.mockResolvedValue(macState());
    const { unmount } = render(<DeviceActivitySettings />);
    await waitFor(() => expect(agent.state).toHaveBeenCalledTimes(1));
    unmount();
    const callsAtUnmount = agent.state.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(agent.state.mock.calls.length).toBe(callsAtUnmount);
  });

  // ── Bug 4: Pause/Disconnect gave zero feedback on failure ──────────────────
  it("shows an error toast when disconnecting fails, same as a failed connect", async () => {
    agent.state.mockResolvedValue(macState());
    agent.pair.mockRejectedValueOnce(new Error("could not reach the pairing service"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DeviceActivitySettings />);
    const button = await screen.findByRole("button", { name: /turn off/i });
    await user.click(button);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("could not reach the pairing service"),
    );
  });

  it("shows an error toast when pausing/resuming fails", async () => {
    agent.state.mockResolvedValue(macState());
    agent.setEnabled.mockRejectedValueOnce(new Error("could not update the sampler"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DeviceActivitySettings />);
    const button = await screen.findByRole("button", { name: /pause/i });
    await user.click(button);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("could not update the sampler"),
    );
  });

  it("shows an error toast when the initial state() load fails", async () => {
    agent.state.mockRejectedValueOnce(new Error("agent not reachable"));
    render(<DeviceActivitySettings />);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("agent not reachable"),
    );
  });

  // ── Bug 5: load() had no guard against an out-of-order response ────────────
  it("discards a stale state() response that resolves after a newer one has already applied", async () => {
    let resolveFirst!: (v: ReturnType<typeof macState>) => void;
    agent.state
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(macState({ titleTracking: false, titleTrackingReason: "fresher" }));

    render(<DeviceActivitySettings />);
    await waitFor(() => expect(agent.state).toHaveBeenCalledTimes(1));

    // A second load() — e.g. the 30s poll tick — fires and resolves before
    // the still in-flight FIRST call does.
    await vi.advanceTimersByTimeAsync(30_000);
    await waitFor(() =>
      expect(screen.getByText(/application names are recorded, but window titles are not yet/i)).toBeTruthy(),
    );
    expect(screen.getByText(/fresher/i)).toBeTruthy();

    // The stale FIRST call resolving afterwards must be discarded rather than
    // clobbering the fresher state already applied above.
    resolveFirst(macState());
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText(/application names are recorded, but window titles are not yet/i)).toBeTruthy();
  });
});
