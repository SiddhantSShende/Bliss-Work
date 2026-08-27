/**
 * Connected devices: revocation, manual extension pairing, and the
 * web-only auto-detect/auto-provision path layered on top of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = {
  listAgentTokens: vi.fn(),
  createAgentToken: vi.fn(),
  revokeAgentToken: vi.fn(),
};
let config: { chromeExtensionId?: string; telemetryBase: string };

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api, config }),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const pingExtension = vi.fn();
const provisionExtension = vi.fn();
vi.mock("../lib/extensionProvisioning", () => ({
  pingExtension: (...args: unknown[]) => pingExtension(...args),
  provisionExtension: (...args: unknown[]) => provisionExtension(...args),
  getOrCreateBrowserDeviceKey: () => "browser-device-key",
}));

import { ConnectedAgents } from "./ConnectedAgents";

function renderWithClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConnectedAgents />
    </QueryClientProvider>,
  );
}

describe("ConnectedAgents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listAgentTokens.mockResolvedValue([]);
    config = { telemetryBase: "https://telemetry.test" };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders today's manual connect flow unchanged when no extension id is configured", async () => {
    renderWithClient();
    await waitFor(() => expect(api.listAgentTokens).toHaveBeenCalled());
    expect(await screen.findByText("Connect a browser extension")).toBeTruthy();
    expect(pingExtension).not.toHaveBeenCalled();
  });

  it("falls back to the manual flow when the extension cannot be detected", async () => {
    config = { chromeExtensionId: "ext-id", telemetryBase: "https://telemetry.test" };
    pingExtension.mockResolvedValue(null);
    renderWithClient();
    await waitFor(() => expect(pingExtension).toHaveBeenCalledWith("ext-id"));
    expect(await screen.findByText("Connect a browser extension")).toBeTruthy();
    expect(api.createAgentToken).not.toHaveBeenCalled();
  });

  it("skips minting entirely when the extension is already connected", async () => {
    config = { chromeExtensionId: "ext-id", telemetryBase: "https://telemetry.test" };
    pingExtension.mockResolvedValue({ connected: true, version: "1.0.0" });
    renderWithClient();

    await waitFor(() =>
      expect(screen.getByText("Browser extension already connected.")).toBeTruthy(),
    );
    expect(api.createAgentToken).not.toHaveBeenCalled();
    expect(screen.queryByText("Connect a browser extension")).toBeNull();
  });

  it("auto-provisions when the extension is installed but not yet connected", async () => {
    config = { chromeExtensionId: "ext-id", telemetryBase: "https://telemetry.test" };
    pingExtension.mockResolvedValue({ connected: false, version: "1.0.0" });
    api.createAgentToken.mockResolvedValue({ id: "t1", kind: "extension", token: "raw-secret" });
    provisionExtension.mockResolvedValue({ ok: true });
    renderWithClient();

    await waitFor(() =>
      expect(screen.getByText("Browser extension connected. Open it to start recording.")).toBeTruthy(),
    );
    expect(api.createAgentToken).toHaveBeenCalledWith("extension", "Browser extension", "browser-device-key");
    expect(provisionExtension).toHaveBeenCalledWith("ext-id", "raw-secret", "https://telemetry.test");
    // The raw secret is never rendered into the page for auto-provisioning —
    // unlike the manual flow, which shows it once for copy/paste.
    expect(screen.queryByText("raw-secret")).toBeNull();
  });

  it("falls back to the manual flow when auto-provisioning fails", async () => {
    config = { chromeExtensionId: "ext-id", telemetryBase: "https://telemetry.test" };
    pingExtension.mockResolvedValue({ connected: false, version: "1.0.0" });
    api.createAgentToken.mockResolvedValue({ id: "t1", kind: "extension", token: "raw-secret" });
    provisionExtension.mockResolvedValue({ ok: false, reason: "unreachable" });
    renderWithClient();

    await waitFor(() => expect(provisionExtension).toHaveBeenCalled());
    expect(await screen.findByText("Connect a browser extension")).toBeTruthy();
  });

  it("still lets a connected agent be revoked from this screen", async () => {
    api.listAgentTokens.mockResolvedValue([
      { id: "a1", kind: "desktop", label: "Work laptop", lastUsedAt: null },
    ]);
    renderWithClient();

    expect(await screen.findByText("Work laptop")).toBeTruthy();
    expect(screen.getByLabelText("Disconnect Work laptop")).toBeTruthy();
  });
});
