/**
 * Connected accounts — the provider cards, the setup guides, and the credentials
 * dialog.
 *
 * This file used to be almost entirely about WhatsApp, which was a Business-only
 * connection needing four Meta credentials. That integration was removed:
 * forwarding to WhatsApp is now a wa.me deep link from the chat's Forward
 * button, which needs no connection at all. What is left here is the generic
 * behaviour every remaining provider shares, plus a guard that the removal
 * actually holds — a half-removed provider (a card with no backend, or a
 * backend with no card) is the failure mode worth pinning.
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
};

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api, config: { kind: "web" } }),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { ConnectedAccounts } from "./ConnectedAccounts";

/** The four providers that remain, in card order. */
const PROVIDER_COUNT = 4;

/** A row left behind by the removed WhatsApp integration. Nothing creates a
 *  pending connection any more, but rows that predate the removal are real. */
const staleP:  IntegrationConnectionDTO = {
  id: "conn-1",
  provider: "whatsapp",
  status: "pending",
  scopeKind: "org",
  displayLabel: "+15550009999",
  scopes: [],
  webhookUrl: "https://bliss.example/ext/whatsapp/webhook/tok",
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

/** Open the Slack credentials dialog. Card order: slack, gmail, outlook, teams. */
async function openSlack(user: ReturnType<typeof userEvent.setup>) {
  const buttons = await screen.findAllByRole("button", { name: /^Connect$/ });
  await user.click(buttons[0]!);
  return screen.getByRole("dialog");
}

beforeEach(() => {
  vi.clearAllMocks();
  api.integrations.mockResolvedValue([]);
});

describe("WhatsApp is gone", () => {
  it("offers no WhatsApp card, guide, or credential fields", async () => {
    renderIt();
    await screen.findAllByRole("button", { name: /^Connect$/ });

    // The specific thing that sent us here: an admin opening Integrations and
    // still being asked for a Meta system-user token.
    expect(screen.queryByText(/WhatsApp/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/System-user token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/WhatsApp Business Account ID/i)).not.toBeInTheDocument();
  });

  it("still lists a pre-existing WhatsApp connection instead of hiding it", async () => {
    // Removing the provider must not make rows already in the database vanish
    // from the UI — that would leave an org unable to disconnect one.
    api.integrations.mockResolvedValue([staleP]);
    renderIt();

    // Surfaced under "No longer supported" rather than under a provider card,
    // because there is no card any more — and an invisible row is one the org
    // can never delete.
    expect(await screen.findByText(/No longer supported/i)).toBeInTheDocument();
    expect(screen.getByText(/\+15550009999/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
    // And it must not advertise a setup that can no longer be completed.
    expect(screen.queryByText(/Paste the webhook URL and verify token/i)).not.toBeInTheDocument();
  });
});

describe("provider cards", () => {
  it("offers one enabled Connect per provider and no second entry point", async () => {
    renderIt();
    const connects = await screen.findAllByRole("button", { name: /^Connect$/ });
    expect(connects).toHaveLength(PROVIDER_COUNT);
    connects.forEach((b) => expect(b).toBeEnabled());
    expect(screen.queryByRole("button", { name: /connect manually/i })).not.toBeInTheDocument();
  });

  it("keeps the setup guides collapsed until asked for", async () => {
    renderIt();
    const toggles = await screen.findAllByRole("button", { name: /setup guide/i });
    expect(toggles).toHaveLength(PROVIDER_COUNT);
    expect(toggles[0]).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a guide with console links that leave the app safely", async () => {
    const user = userEvent.setup();
    renderIt();
    const toggles = await screen.findAllByRole("button", { name: /setup guide/i });
    await user.click(toggles[0]!);

    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    }
  });
});

describe("the credentials dialog", () => {
  it("sends exactly the declared fields, and nothing else", async () => {
    const user = userEvent.setup();
    api.connectIntegration.mockResolvedValue({
      connection: { ...staleP, provider: "slack", status: "connected" },
    });
    renderIt();
    const dialog = await openSlack(user);

    await user.type(within(dialog).getByLabelText(/Bot token/i), "xoxb-1");
    await user.type(within(dialog).getByLabelText(/Signing secret/i), "sig-1");
    await user.click(within(dialog).getByRole("button", { name: /^Connect$/ }));

    await waitFor(() =>
      expect(api.connectIntegration).toHaveBeenCalledWith("slack", {
        botToken: "xoxb-1",
        signingSecret: "sig-1",
      }),
    );
  });

  it("cannot be submitted with a field left blank", async () => {
    const user = userEvent.setup();
    renderIt();
    const dialog = await openSlack(user);

    await user.type(within(dialog).getByLabelText(/Bot token/i), "xoxb-1");
    expect(within(dialog).getByRole("button", { name: /^Connect$/ })).toBeDisabled();
  });

  it("shows the server's rejection reason rather than a generic failure", async () => {
    const user = userEvent.setup();
    const { ApiError } = await import("@taskboard/shared");
    api.connectIntegration.mockRejectedValue(new ApiError(400, "Slack rejected the token: bad_auth"));
    renderIt();
    const dialog = await openSlack(user);

    await user.type(within(dialog).getByLabelText(/Bot token/i), "t");
    await user.type(within(dialog).getByLabelText(/Signing secret/i), "s");
    await user.click(within(dialog).getByRole("button", { name: /^Connect$/ }));

    // Which check failed is the only actionable part of the response.
    expect(await screen.findByText(/bad_auth/i)).toBeInTheDocument();
  });
});
