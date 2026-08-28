/**
 * Desktop's browser-extension provisioning screen: what it can honestly show
 * (which supported browsers are installed) and what it deliberately does
 * NOT claim (connected/not-connected — see the component's own doc comment
 * on why that's undecidable from Electron).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const browserAgent = { list: vi.fn(), launch: vi.fn() };
let config: { kind: string; browserAgent?: typeof browserAgent };

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ config }),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { BrowserExtensionProvisioning } from "./BrowserExtensionProvisioning";
import { toast } from "sonner";

describe("BrowserExtensionProvisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config = { kind: "desktop", browserAgent };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing on web, where there is no browserAgent", () => {
    config = { kind: "web" };
    const { container } = render(<BrowserExtensionProvisioning />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists only the installed browsers, each with a Connect action — never a connected/not-connected claim", async () => {
    browserAgent.list.mockResolvedValue([
      { family: "chrome", label: "Google Chrome", path: "/usr/bin/google-chrome", installed: true },
      { family: "firefox", label: "Firefox", path: null, installed: false },
    ]);
    render(<BrowserExtensionProvisioning />);

    expect(await screen.findByText("Google Chrome")).toBeTruthy();
    expect(screen.queryByText("Firefox")).toBeNull();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(screen.queryByText(/connected/i)).toBeNull();
  });

  it("says so plainly when no supported browser is found", async () => {
    browserAgent.list.mockResolvedValue([]);
    render(<BrowserExtensionProvisioning />);

    expect(await screen.findByText("No supported browser was found on this device.")).toBeTruthy();
  });

  it("launches the detected browser at its own path via the agent, and surfaces a failure", async () => {
    browserAgent.list.mockResolvedValue([
      { family: "chrome", label: "Google Chrome", path: "/usr/bin/google-chrome", installed: true },
    ]);
    browserAgent.launch.mockResolvedValue(false);
    render(<BrowserExtensionProvisioning />);

    const button = await screen.findByRole("button", { name: "Connect" });
    button.click();

    await waitFor(() => expect(browserAgent.launch).toHaveBeenCalledWith("/usr/bin/google-chrome"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't open Google Chrome"));
  });
});
