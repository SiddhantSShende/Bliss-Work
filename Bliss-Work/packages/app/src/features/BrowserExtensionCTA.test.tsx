/**
 * The sign-in page's "Browser Activity Tracking" CTA — detection-only (no
 * session exists yet), so these tests assert it never mints or provisions
 * anything, only ever pings. The mint/provision half is covered against the
 * same underlying hook in ConnectedAgents.test.tsx (autoProvision: true) and
 * agentProvisioning.test.tsx (ExtensionProvisioningBridge).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

let config: {
  kind: "web" | "electron";
  chromeExtensionId?: string;
  extensionInstallUrls?: Partial<Record<string, string>>;
  telemetryBase: string;
};
const api = { createAgentToken: vi.fn() };

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api, config }),
}));

const pingExtension = vi.fn();
vi.mock("../lib/extensionProvisioning", () => ({
  pingExtension: (...args: unknown[]) => pingExtension(...args),
  provisionExtension: vi.fn(),
  getOrCreateBrowserDeviceKey: () => "browser-device-key",
}));

let family: "chrome" | "edge" | "brave" | "firefox" | "safari" | "unknown" = "chrome";
vi.mock("../lib/browserDetect", () => ({
  detectBrowserFamily: () => family,
  supportsAutoExtensionIntegration: (f: string) => f === "chrome" || f === "edge" || f === "brave",
}));

import { BrowserExtensionCTA } from "./BrowserExtensionCTA";

describe("BrowserExtensionCTA", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    family = "chrome";
    config = { kind: "web", chromeExtensionId: "ext-id", telemetryBase: "https://telemetry.test" };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing on the desktop app's own sign-in screen", () => {
    // Matches real Electron config (apps/desktop/src/renderer/main.tsx never
    // sets chromeExtensionId — the desktop app has its own agent instead).
    config = { kind: "electron", telemetryBase: "https://telemetry.test" };
    const { container } = render(<BrowserExtensionCTA />);
    expect(container).toBeEmptyDOMElement();
    expect(pingExtension).not.toHaveBeenCalled();
  });

  it("shows Extension Connected when the extension already holds a token — never attempts to mint one", async () => {
    pingExtension.mockResolvedValue({ connected: true, version: "1.0.0" });
    render(<BrowserExtensionCTA />);
    await waitFor(() => expect(screen.getByText("Extension Connected")).toBeTruthy());
    expect(api.createAgentToken).not.toHaveBeenCalled();
  });

  it("shows Extension Not Connected with a Reconnect action when the extension is present but unpaired", async () => {
    pingExtension.mockResolvedValue({ connected: false, version: "1.0.0" });
    render(<BrowserExtensionCTA />);
    await waitFor(() => expect(screen.getByText("Extension Not Connected")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    // Pre-auth: detection only, never a mint attempt.
    expect(api.createAgentToken).not.toHaveBeenCalled();
  });

  it("offers Install Browser Extension when not detected and an install URL is configured", async () => {
    config.extensionInstallUrls = { chrome: "https://chrome.example/install" };
    pingExtension.mockResolvedValue(null);
    render(<BrowserExtensionCTA />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Install Browser Extension" })).toBeTruthy());
  });

  it("shows the unsupported message on Firefox, even with an id configured, rather than a dead install button", async () => {
    family = "firefox";
    pingExtension.mockResolvedValue(null);
    render(<BrowserExtensionCTA />);
    await waitFor(() =>
      expect(screen.getByText("Browser not supported for automatic extension integration.")).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "Install Browser Extension" })).toBeNull();
  });

  it("shows the unsupported message when nothing is detected AND no install URL exists for this deployment yet", async () => {
    pingExtension.mockResolvedValue(null);
    render(<BrowserExtensionCTA />); // config.extensionInstallUrls left unset
    await waitFor(() =>
      expect(screen.getByText("Browser not supported for automatic extension integration.")).toBeTruthy(),
    );
  });
});
