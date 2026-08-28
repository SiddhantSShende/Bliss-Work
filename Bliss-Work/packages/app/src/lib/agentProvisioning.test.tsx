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
// Mutable so the ExtensionProvisioningBridge tests below can swap in a
// chromeExtensionId-carrying config without disturbing AgentProvisioningBridge's
// own tests, which always run against the desktop shape.
let config: Record<string, unknown> = { kind: "desktop", activityAgent: agent };

vi.mock("./runtime", () => ({
  useRuntime: () => ({ api, config }),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const pingExtension = vi.fn();
const provisionExtension = vi.fn();
vi.mock("./extensionProvisioning", () => ({
  pingExtension: (...args: unknown[]) => pingExtension(...args),
  provisionExtension: (...args: unknown[]) => provisionExtension(...args),
  getOrCreateBrowserDeviceKey: () => "browser-device-key",
}));

import { toast } from "sonner";
import { AgentProvisioningBridge, ExtensionProvisioningBridge } from "./agentProvisioning";

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
    config = { kind: "desktop", activityAgent: agent };
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

/**
 * The web-side counterpart: finishes connecting the browser extension right
 * after sign-in, using the exact same detect/mint/provision protocol
 * ConnectedAgents.tsx uses (see useExtensionConnection.ts) — what's under
 * test here is only the login gate and the one-time "it just connected"
 * toast, not the protocol itself.
 */
describe("ExtensionProvisioningBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSession.getState().clear();
    config = { kind: "web", chromeExtensionId: "ext-id", telemetryBase: "https://telemetry.test" };
  });

  afterEach(() => {
    useSession.getState().clear();
  });

  it("does not even ping before a session exists — minting needs auth, and pinging pre-login is the sign-in page CTA's job, not this bridge's", async () => {
    render(<ExtensionProvisioningBridge />);
    await new Promise((r) => setTimeout(r, 0));
    expect(pingExtension).not.toHaveBeenCalled();
  });

  it("mints and provisions once signed in, and announces the fresh connection", async () => {
    pingExtension.mockResolvedValue({ connected: false, version: "1.0.0" });
    api.createAgentToken.mockResolvedValue({ id: "t1", kind: "extension", token: "raw-secret" });
    provisionExtension.mockResolvedValue({ ok: true });
    signIn();

    render(<ExtensionProvisioningBridge />);

    await waitFor(() => expect(provisionExtension).toHaveBeenCalledWith("ext-id", "raw-secret", "https://telemetry.test"));
    expect(toast).toHaveBeenCalledWith(
      "Browser extension connected",
      expect.objectContaining({ description: expect.any(String) }),
    );
  });

  it("stays quiet when the extension was already connected — no toast for a no-op", async () => {
    pingExtension.mockResolvedValue({ connected: true, version: "1.0.0" });
    signIn();

    render(<ExtensionProvisioningBridge />);

    await waitFor(() => expect(pingExtension).toHaveBeenCalled());
    expect(api.createAgentToken).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("is inert when this deployment has no chromeExtensionId configured", async () => {
    config = { kind: "web", telemetryBase: "https://telemetry.test" };
    signIn();

    render(<ExtensionProvisioningBridge />);

    await new Promise((r) => setTimeout(r, 0));
    expect(pingExtension).not.toHaveBeenCalled();
  });
});
