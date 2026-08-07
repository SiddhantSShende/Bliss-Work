/**
 * Connected accounts — setup guides and the two-step WhatsApp confirmation.
 *
 * The confirmation exists because credentials validating proves nothing about
 * whether the connection actually works, so the behavior worth pinning here is
 * the part a refactor could quietly undo: the number is NOT sent as a
 * credential, a pending connection stays visible and re-openable, and the
 * "we couldn't message you" branch shows the reply keyword instead of a code
 * box the user has no way to fill.
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
  startIntegrationVerification: vi.fn(),
  confirmIntegrationVerification: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  api.integrations.mockResolvedValue([]);
});

describe("setup guides", () => {
  it("keeps the steps collapsed until asked for", async () => {
    renderIt();
    const toggles = await screen.findAllByRole("button", { name: /setup guide/i });
    // One per provider, all collapsed — the guide is read once during setup.
    expect(toggles.length).toBeGreaterThanOrEqual(5);
    expect(toggles[0]).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Add the WhatsApp product/i)).not.toBeInTheDocument();
  });

  it("shows the provider's own steps and console link when expanded", async () => {
    const user = userEvent.setup();
    renderIt();
    const toggles = await screen.findAllByRole("button", { name: /setup guide/i });
    // PROVIDERS order: slack, whatsapp, gmail, outlook, teams.
    await user.click(toggles[1]!);

    expect(screen.getByText(/add the WhatsApp product/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Meta for Developers/i });
    expect(link).toHaveAttribute("href", "https://developers.facebook.com/apps");
    // Opening a console in-app would trap the user in a webview with no chrome.
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });
});

describe("WhatsApp confirmation", () => {
  it("sends credentials and the number as SEPARATE things", async () => {
    const user = userEvent.setup();
    api.connectIntegration.mockResolvedValue({ connection: { ...pendingConn } });
    api.startIntegrationVerification.mockResolvedValue({
      delivery: "sent",
      businessNumber: "+15550009999",
    });
    renderIt();

    const connectButtons = await screen.findAllByRole("button", { name: /^Connect$/ });
    await user.click(connectButtons[1]!); // WhatsApp

    await user.type(screen.getByLabelText(/System-user token/i), "EAAG-token");
    await user.type(screen.getByLabelText(/Phone number ID/i), "PNID-1");
    await user.type(screen.getByLabelText(/App secret/i), "app-secret");
    await user.type(screen.getByLabelText(/Your WhatsApp number/i), "+15551234567");
    // Scoped to the dialog: the provider cards behind it also say "Connect".
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Connect$/ }));

    await waitFor(() => expect(api.connectIntegration).toHaveBeenCalled());
    // THE assertion: the admin's number is not a credential and must never end
    // up in the encrypted credential blob the server persists.
    expect(api.connectIntegration).toHaveBeenCalledWith("whatsapp", {
      accessToken: "EAAG-token",
      phoneNumberId: "PNID-1",
      appSecret: "app-secret",
    });
    expect(api.startIntegrationVerification).toHaveBeenCalledWith("conn-1", {
      to: "+15551234567",
      template: undefined,
    });
  });

  it("asks for the code once it has been sent", async () => {
    const user = userEvent.setup();
    api.connectIntegration.mockResolvedValue({ connection: { ...pendingConn } });
    api.startIntegrationVerification.mockResolvedValue({
      delivery: "sent",
      businessNumber: "+15550009999",
    });
    api.confirmIntegrationVerification.mockResolvedValue({ status: "connected" });
    renderIt();

    const connectButtons = await screen.findAllByRole("button", { name: /^Connect$/ });
    await user.click(connectButtons[1]!);
    await user.type(screen.getByLabelText(/System-user token/i), "t");
    await user.type(screen.getByLabelText(/Phone number ID/i), "p");
    await user.type(screen.getByLabelText(/App secret/i), "s");
    await user.type(screen.getByLabelText(/Your WhatsApp number/i), "+1555");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Connect$/ }));

    const codeBox = await screen.findByLabelText(/Confirmation code/i);
    await user.type(codeBox, "482193");
    await user.click(screen.getByRole("button", { name: /^Confirm$/ }));

    await waitFor(() =>
      expect(api.confirmIntegrationVerification).toHaveBeenCalledWith("conn-1", "482193"),
    );
  });

  it("shows the reply keyword when we couldn't message the number first", async () => {
    const user = userEvent.setup();
    api.connectIntegration.mockResolvedValue({ connection: { ...pendingConn } });
    api.startIntegrationVerification.mockResolvedValue({
      delivery: "reply_required",
      replyKeyword: "CONFIRM 482193",
      businessNumber: "+15550009999",
      reason: "That number hasn't messaged your business number recently.",
    });
    renderIt();

    const connectButtons = await screen.findAllByRole("button", { name: /^Connect$/ });
    await user.click(connectButtons[1]!);
    await user.type(screen.getByLabelText(/System-user token/i), "t");
    await user.type(screen.getByLabelText(/Phone number ID/i), "p");
    await user.type(screen.getByLabelText(/App secret/i), "s");
    await user.type(screen.getByLabelText(/Your WhatsApp number/i), "+1555");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Connect$/ }));

    expect(await screen.findByText("CONFIRM 482193")).toBeInTheDocument();
    expect(screen.getByText("+15550009999")).toBeInTheDocument();
    // There is no code to type in this branch — offering a box the user cannot
    // fill is how the original design would have dead-ended.
    expect(screen.queryByLabelText(/Confirmation code/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Confirm$/ })).not.toBeInTheDocument();
  });
});

describe("pending connections", () => {
  it("stays visible with a way back into confirmation", async () => {
    const user = userEvent.setup();
    api.integrations.mockResolvedValue([pendingConn]);
    api.startIntegrationVerification.mockResolvedValue({
      delivery: "sent",
      businessNumber: "+15550009999",
    });
    renderIt();

    expect(await screen.findByText(/Pending confirmation/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Confirm number/i }));

    // Credentials are already stored (and can't be read back), so resuming asks
    // only for somewhere to send the code.
    expect(await screen.findByLabelText(/Your WhatsApp number/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/System-user token/i)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/Your WhatsApp number/i), "+1555");
    await user.click(screen.getByRole("button", { name: /Send code/i }));
    await waitFor(() =>
      expect(api.startIntegrationVerification).toHaveBeenCalledWith("conn-1", {
        to: "+1555",
        template: undefined,
      }),
    );
    // Connecting is never re-run when resuming — that would re-post credentials
    // the dialog does not have.
    expect(api.connectIntegration).not.toHaveBeenCalled();
  });

  it("shows the webhook setup expanded, because it's a required step while pending", async () => {
    api.integrations.mockResolvedValue([pendingConn]);
    renderIt();
    // The reply-in confirmation route can't work until Meta is pointed at this
    // URL, so it isn't collapsed reference detail at this moment.
    expect(await screen.findByText(pendingConn.webhookUrl!)).toBeInTheDocument();
    expect(screen.getByText("vtok")).toBeInTheDocument();
  });
});
