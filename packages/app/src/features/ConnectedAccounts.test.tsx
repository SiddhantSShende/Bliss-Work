/**
 * Connected accounts — setup guides, and WhatsApp as a Business-only connection.
 *
 * WhatsApp briefly asked for the admin's own phone number and a confirmation
 * code. It doesn't any more: the integration is Business-accounts-only and the
 * connection is confirmed by Meta calling our webhook. The behaviour worth
 * pinning is what a refactor could quietly reintroduce or lose — no personal
 * number anywhere, all four credentials sent as credentials, and a pending
 * connection that explains itself instead of offering an in-app action that
 * cannot finish the job.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IntegrationConnectionDTO } from "@taskboard/shared";

const api = {
  integrations: vi.fn(),
  connectIntegration: vi.fn(),
  disconnectIntegration: vi.fn(),
  whatsappEmbeddedConfig: vi.fn(),
  connectWhatsAppEmbedded: vi.fn(),
};

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api, config: { kind: "web" } }),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { ConnectedAccounts } from "./ConnectedAccounts";

const pendingConn: IntegrationConnectionDTO = {
  id: "conn-1",
  provider: "whatsapp",
  status: "pending",
  scopeKind: "org",
  displayLabel: "+15550009999",
  scopes: [],
  webhookUrl: "https://bliss.example/ext/whatsapp/webhook/tok",
  webhookVerifyToken: "vtok",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConnectedAccounts />
    </QueryClientProvider>,
  );
}

/** Open the MANUAL (advanced) WhatsApp credentials dialog. */
async function openWhatsApp(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /connect manually/i }));
  return screen.getByRole("dialog");
}

beforeEach(() => {
  vi.clearAllMocks();
  api.integrations.mockResolvedValue([]);
  // Default: this deployment is not a Meta Tech Provider yet.
  api.whatsappEmbeddedConfig.mockResolvedValue({
    available: false,
    appId: "",
    configId: "",
    graphVersion: "v21.0",
  });
});

describe("setup guides", () => {
  it("keeps the steps collapsed until asked for", async () => {
    renderIt();
    const toggles = await screen.findAllByRole("button", { name: /setup guide/i });
    expect(toggles.length).toBeGreaterThanOrEqual(5);
    expect(toggles[0]).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/add the WhatsApp product/i)).not.toBeInTheDocument();
  });

  it("leads the WhatsApp guide with the business-only requirement", async () => {
    const user = userEvent.setup();
    renderIt();
    const toggles = await screen.findAllByRole("button", { name: /setup guide/i });
    await user.click(toggles[1]!);

    // The restriction has to be the FIRST thing read, not a footnote — someone
    // with a personal account should stop before collecting four credentials.
    const steps = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(steps[0]).toMatch(/Business accounts only/i);
    expect(steps[0]).toMatch(/personal WhatsApp account can't be connected/i);
    // Both permissions, because granting only the messaging one is the usual
    // first failure and the guide is where it gets prevented.
    expect(steps.join(" ")).toMatch(/whatsapp_business_management/);

    const link = screen.getByRole("link", { name: /Meta for Developers/i });
    expect(link).toHaveAttribute("href", "https://developers.facebook.com/apps");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });
});

describe("WhatsApp connect", () => {
  it("asks for four credentials and no phone number", async () => {
    const user = userEvent.setup();
    renderIt();
    const dialog = await openWhatsApp(user);

    within(dialog).getByLabelText(/System-user token/i);
    within(dialog).getByLabelText(/WhatsApp Business Account ID/i);
    within(dialog).getByLabelText(/Phone number ID/i);
    within(dialog).getByLabelText(/App secret/i);

    // The personal-number and template fields are gone for good.
    expect(within(dialog).queryByLabelText(/Your WhatsApp number/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/template/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/Confirmation code/i)).not.toBeInTheDocument();
  });

  it("sends all four as credentials in one step", async () => {
    const user = userEvent.setup();
    api.connectIntegration.mockResolvedValue({ connection: { ...pendingConn } });
    renderIt();
    const dialog = await openWhatsApp(user);

    await user.type(within(dialog).getByLabelText(/System-user token/i), "EAAG-token");
    await user.type(within(dialog).getByLabelText(/WhatsApp Business Account ID/i), "WABA-1");
    await user.type(within(dialog).getByLabelText(/Phone number ID/i), "PNID-1");
    await user.type(within(dialog).getByLabelText(/App secret/i), "app-secret");
    await user.click(within(dialog).getByRole("button", { name: /^Connect$/ }));

    await waitFor(() =>
      expect(api.connectIntegration).toHaveBeenCalledWith("whatsapp", {
        accessToken: "EAAG-token",
        wabaId: "WABA-1",
        phoneNumberId: "PNID-1",
        appSecret: "app-secret",
      }),
    );
  });

  it("cannot be submitted without the Business Account ID", async () => {
    const user = userEvent.setup();
    renderIt();
    const dialog = await openWhatsApp(user);

    await user.type(within(dialog).getByLabelText(/System-user token/i), "t");
    await user.type(within(dialog).getByLabelText(/Phone number ID/i), "p");
    await user.type(within(dialog).getByLabelText(/App secret/i), "s");
    // Without it the server has nothing to check membership against, so the
    // gate would be unenforceable — don't let the request leave.
    expect(within(dialog).getByRole("button", { name: /^Connect$/ })).toBeDisabled();
  });

  it("shows the server's rejection reason rather than a generic failure", async () => {
    const user = userEvent.setup();
    const { ApiError } = await import("@taskboard/shared");
    api.connectIntegration.mockRejectedValue(
      new ApiError(400, "that business number hasn't completed Meta's verification yet"),
    );
    renderIt();
    const dialog = await openWhatsApp(user);

    await user.type(within(dialog).getByLabelText(/System-user token/i), "t");
    await user.type(within(dialog).getByLabelText(/WhatsApp Business Account ID/i), "w");
    await user.type(within(dialog).getByLabelText(/Phone number ID/i), "p");
    await user.type(within(dialog).getByLabelText(/App secret/i), "s");
    await user.click(within(dialog).getByRole("button", { name: /^Connect$/ }));

    // Which check failed is the only actionable part of the response.
    expect(await screen.findByText(/hasn't completed Meta's verification/i)).toBeInTheDocument();
  });
});

describe("a connection waiting on Meta", () => {
  it("says what is outstanding and offers no in-app action", async () => {
    api.integrations.mockResolvedValue([pendingConn]);
    renderIt();

    expect(await screen.findByText(/Waiting for Meta/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Paste the webhook URL and verify token below into Meta/i),
    ).toBeInTheDocument();
    // The remaining step happens in Meta's dashboard; a button here would imply
    // otherwise. (The old flow had "Confirm number".)
    expect(screen.queryByRole("button", { name: /confirm/i })).not.toBeInTheDocument();
  });

  it("shows the webhook setup expanded, since pasting it IS the last step", async () => {
    api.integrations.mockResolvedValue([pendingConn]);
    renderIt();
    expect(await screen.findByText(pendingConn.webhookUrl!)).toBeInTheDocument();
    expect(screen.getByText("vtok")).toBeInTheDocument();
  });
});


describe("one-click WhatsApp Business signup", () => {
  it("stays disabled, with the manual path still reachable, until we're a Tech Provider", async () => {
    renderIt();
    // Embedded Signup needs Meta to approve BlissWork, not the customer. Until
    // then the button must say so rather than open a popup that dies at Meta —
    // and the manual flow has to remain usable, or WhatsApp is unconnectable.
    const primary = await screen.findByRole("button", { name: /Connect WhatsApp Business/i });
    await waitFor(() => expect(primary).toBeDisabled());
    expect(screen.getByRole("button", { name: /connect manually/i })).toBeEnabled();
  });

  it("opens Meta's popup and exchanges the code it posts back", async () => {
    const user = userEvent.setup();
    api.whatsappEmbeddedConfig.mockResolvedValue({
      available: true,
      appId: "APP-1",
      configId: "CFG-1",
      graphVersion: "v21.0",
    });
    api.connectWhatsAppEmbedded.mockResolvedValue({ connection: { ...pendingConn, status: "connected" } });
    const popup = { closed: false } as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(popup);
    renderIt();

    const primary = await screen.findByRole("button", { name: /Connect WhatsApp Business/i });
    await waitFor(() => expect(primary).toBeEnabled());
    await user.click(primary);

    // The SDK is quarantined on its own page so the app's CSP never has to
    // admit connect.facebook.net.
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining("/whatsapp-connect.html?appId=APP-1&configId=CFG-1"),
      expect.anything(),
      expect.anything(),
    );

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: { source: "blisswork-whatsapp", code: "c1", wabaId: "W1", phoneNumberId: "P1" },
      }),
    );
    await waitFor(() =>
      expect(api.connectWhatsAppEmbedded).toHaveBeenCalledWith({
        code: "c1",
        wabaId: "W1",
        phoneNumberId: "P1",
      }),
    );
    open.mockRestore();
  });

  it("ignores a signup message from any other origin", async () => {
    const user = userEvent.setup();
    api.whatsappEmbeddedConfig.mockResolvedValue({
      available: true,
      appId: "APP-1",
      configId: "CFG-1",
      graphVersion: "v21.0",
    });
    const open = vi.spyOn(window, "open").mockReturnValue({ closed: false } as Window);
    renderIt();
    const primary = await screen.findByRole("button", { name: /Connect WhatsApp Business/i });
    await waitFor(() => expect(primary).toBeEnabled());
    await user.click(primary);

    // The message carries an authorization code. Anything not from our own
    // popup page is not ours to trust.
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://evil.example",
        data: { source: "blisswork-whatsapp", code: "stolen", wabaId: "W", phoneNumberId: "P" },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(api.connectWhatsAppEmbedded).not.toHaveBeenCalled();
    open.mockRestore();
  });
});
