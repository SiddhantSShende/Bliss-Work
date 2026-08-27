/**
 * Automatic desktop-agent provisioning — the mechanism only, never consent.
 * A pairing token must be minted and handed to the main process without ever
 * calling agent.setEnabled(true): that stays the person's own explicit
 * choice in Settings, exactly as it is today.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { useSession } from "../store/session";

const agent = {
  state: vi.fn(),
  setEnabled: vi.fn(),
  pair: vi.fn(),
  openScreenRecordingSettings: vi.fn(),
};
const api = {
  createAgentToken: vi.fn(),
  revokeAgentToken: vi.fn(),
};

vi.mock("./runtime", () => ({
  useRuntime: () => ({ api, config: { kind: "desktop", activityAgent: agent } }),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { AgentProvisioningBridge } from "./agentProvisioning";

function pairedState(over: Partial<Awaited<ReturnType<typeof agent.state>>> = {}) {
  return {
    enabled: false,
    paired: false,
    deviceKey: "device-key-1",
    appTracking: true,
    reason: null,
    titleTracking: true,
    titleTrackingReason: null,
    ...over,
  };
}

function signIn() {
  useSession.getState().setSession({
    user: { id: "u1" } as never,
    accessToken: "live-token",
    expiresIn: 900,
  });
}

describe("AgentProvisioningBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSession.getState().clear();
  });

  afterEach(() => {
    useSession.getState().clear();
  });

  it("mints and pairs on first install, and never enables sampling on its own", async () => {
    agent.state.mockResolvedValue(pairedState({ paired: false }));
    api.createAgentToken.mockResolvedValue({ id: "t1", kind: "desktop", token: "raw-secret" });
    signIn();

    render(<AgentProvisioningBridge />);

    await waitFor(() => expect(agent.pair).toHaveBeenCalledWith("raw-secret"));
    expect(api.createAgentToken).toHaveBeenCalledWith("desktop", expect.any(String), "device-key-1");
    expect(agent.setEnabled).not.toHaveBeenCalled();
  });

  it("is a no-op when already paired — idempotent, no mint call at all", async () => {
    agent.state.mockResolvedValue(pairedState({ paired: true, enabled: false }));
    signIn();

    render(<AgentProvisioningBridge />);

    await waitFor(() => expect(agent.state).toHaveBeenCalled());
    expect(api.createAgentToken).not.toHaveBeenCalled();
    expect(agent.pair).not.toHaveBeenCalled();
  });

  it("handles a mint failure gracefully — no pairing, no crash, no state change", async () => {
    agent.state.mockResolvedValue(pairedState({ paired: false }));
    api.createAgentToken.mockRejectedValue(new Error("network down"));
    signIn();

    render(<AgentProvisioningBridge />);

    await waitFor(() => expect(api.createAgentToken).toHaveBeenCalled());
    expect(agent.pair).not.toHaveBeenCalled();
  });

  it("self-heals a lost double-submit: revokes the orphaned row and retries once", async () => {
    agent.state.mockResolvedValue(pairedState({ paired: false }));
    api.createAgentToken
      .mockResolvedValueOnce({ id: "orphan-1", kind: "desktop", token: null })
      .mockResolvedValueOnce({ id: "orphan-1", kind: "desktop", token: "fresh-secret" });
    api.revokeAgentToken.mockResolvedValue(undefined);
    signIn();

    render(<AgentProvisioningBridge />);

    await waitFor(() => expect(agent.pair).toHaveBeenCalledWith("fresh-secret"));
    expect(api.revokeAgentToken).toHaveBeenCalledWith("orphan-1");
    expect(api.createAgentToken).toHaveBeenCalledTimes(2);
  });

  it("does nothing before a session exists", async () => {
    agent.state.mockResolvedValue(pairedState({ paired: false }));
    render(<AgentProvisioningBridge />);

    await new Promise((r) => setTimeout(r, 0));
    expect(agent.state).not.toHaveBeenCalled();
  });
});
