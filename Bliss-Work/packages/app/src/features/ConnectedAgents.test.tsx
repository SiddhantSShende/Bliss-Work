/**
 * Connected devices: revocation, manual extension pairing, and the
 * web-only auto-detect/auto-provision path layered on top of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = {
  listAgentTokens: vi.fn(),
  createAgentToken: vi.fn(),
  revokeAgentToken: vi.fn(),
};
let config: {
  chromeExtensionId?: string;
  extensionInstallUrls?: Partial<Record<string, string>>;
  telemetryBase: string;
};

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

// Same mocking convention BrowserExtensionCTA.test.tsx uses — a mutable
// `family` rather than fighting jsdom's fixed navigator.userAgent.
let family: "chrome" | "edge" | "brave" | "firefox" | "safari" | "unknown" = "chrome";
vi.mock("../lib/browserDetect", () => ({
  detectBrowserFamily: () => family,
  supportsAutoExtensionIntegration: (f: string) => f === "chrome" || f === "edge" || f === "brave",
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
    family = "chrome";
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

  it("shows an unsupported message, not the manual paste flow, when nothing is detected and no install URL exists", async () => {
    // No extensionInstallUrls configured — pasting a code into an extension
    // that was never given anywhere to download it from would be exactly the
    // dead end this fix removes.
    config = { chromeExtensionId: "ext-id", telemetryBase: "https://telemetry.test" };
    pingExtension.mockResolvedValue(null);
    renderWithClient();
    await waitFor(() => expect(pingExtension).toHaveBeenCalledWith("ext-id"));
    expect(
      await screen.findByText(
        "Automatic setup isn't available for this browser yet — connect from Chrome, Edge or Brave instead.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Connect a browser extension")).toBeNull();
    expect(api.createAgentToken).not.toHaveBeenCalled();
  });

  it("offers a download link and re-check action when not installed and this deployment has somewhere to send them", async () => {
    config = {
      chromeExtensionId: "ext-id",
      telemetryBase: "https://telemetry.test",
      extensionInstallUrls: { chrome: "https://downloads.example/blisswork-extension.zip" },
    };
    pingExtension.mockResolvedValue(null);
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    renderWithClient();

    await waitFor(() => expect(pingExtension).toHaveBeenCalledWith("ext-id"));
    expect(
      await screen.findByText(
        "Download the BlissWork extension for Google Chrome, then load it — it pairs with your account automatically once it's running.",
      ),
    ).toBeTruthy();
    const download = await screen.findByRole("button", { name: "Download extension" });
    expect(screen.queryByText("Connect a browser extension")).toBeNull();

    fireEvent.click(download);
    expect(openSpy).toHaveBeenCalledWith(
      "https://downloads.example/blisswork-extension.zip",
      "_blank",
      "noopener,noreferrer",
    );

    pingExtension.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "I installed it — check again" }));
    await waitFor(() => expect(pingExtension).toHaveBeenCalledWith("ext-id"));
  });

  it("shows a detecting state during the initial silent check, never the manual button", async () => {
    config = { chromeExtensionId: "ext-id", telemetryBase: "https://telemetry.test" };
    let resolvePing!: (v: null) => void;
    pingExtension.mockReturnValue(new Promise((resolve) => { resolvePing = resolve; }));
    renderWithClient();

    expect(await screen.findByText("Detecting browser…")).toBeTruthy();
    expect(screen.queryByText("Connect a browser extension")).toBeNull();

    resolvePing(null);
    await waitFor(() => expect(pingExtension).toHaveBeenCalled());
  });

  it("shows a connecting state while auto-pairing an already-installed extension", async () => {
    config = { chromeExtensionId: "ext-id", telemetryBase: "https://telemetry.test" };
    pingExtension.mockResolvedValue({ connected: false, version: "1.0.0" });
    api.createAgentToken.mockResolvedValue({ id: "t1", kind: "extension", token: "raw-secret" });
    let resolveProvision!: (v: { ok: boolean }) => void;
    provisionExtension.mockReturnValue(new Promise((resolve) => { resolveProvision = resolve; }));
    renderWithClient();

    expect(await screen.findByText("Connecting extension…")).toBeTruthy();

    resolveProvision({ ok: true });
    await waitFor(() =>
      expect(screen.getByText("Browser extension connected. Open it to start recording.")).toBeTruthy(),
    );
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
