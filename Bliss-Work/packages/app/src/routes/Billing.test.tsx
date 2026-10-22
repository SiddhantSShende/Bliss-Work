import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const h = vi.hoisted(() => ({
  billingBalance: vi.fn(),
  billingLedger: vi.fn(),
  billingPackages: vi.fn(),
  billingPricing: vi.fn(),
}));
const configMock = vi.hoisted(() => ({ billingBase: "http://billing.test" as string | undefined }));
vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: h, config: configMock }),
}));

const sessionMock = vi.hoisted(() => ({ roles: ["org_admin"] }));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: { user: { roles: string[] } }) => unknown) => sel({ user: sessionMock }),
}));

import { Billing } from "./Billing";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionMock.roles = ["org_admin"];
  configMock.billingBase = "http://billing.test";
});

function renderBilling() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Billing />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Billing (org settings)", () => {
  it("shows an admins-only message to a member and never calls the billing API", () => {
    sessionMock.roles = ["member"];
    renderBilling();
    expect(screen.getByText(/admins only/i)).toBeInTheDocument();
    expect(h.billingBalance).not.toHaveBeenCalled();
  });

  it("shows a loading state, then balance/pricing/packages/ledger for an admin", async () => {
    h.billingBalance.mockResolvedValue({ orgId: "org-1", balance: 42 });
    h.billingLedger.mockResolvedValue([
      { id: "l1", delta: 3, balanceAfter: 42, reason: "monthly_grant", referenceType: null, referenceId: null, createdAt: "2026-10-01T00:00:00Z" },
    ]);
    h.billingPackages.mockResolvedValue([{ id: "p1", name: "Starter", credits: 100, priceCents: 10000, currency: "usd", active: true }]);
    h.billingPricing.mockResolvedValue([
      { key: "admin_monthly_credits", value: 3, updatedAt: "2026-01-01T00:00:00Z", updatedBy: null },
      { key: "member_monthly_credits", value: 1, updatedAt: "2026-01-01T00:00:00Z", updatedBy: null },
      { key: "admin_reference_price_cents", value: 800, updatedAt: "2026-01-01T00:00:00Z", updatedBy: null },
      { key: "member_reference_price_cents", value: 500, updatedAt: "2026-01-01T00:00:00Z", updatedBy: null },
      { key: "admin_current_price_cents", value: 300, updatedAt: "2026-01-01T00:00:00Z", updatedBy: null },
      { key: "member_current_price_cents", value: 100, updatedAt: "2026-01-01T00:00:00Z", updatedBy: null },
    ]);

    renderBilling();
    expect(screen.getByText(/loading billing information/i)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("42 credits")).toBeInTheDocument());
    expect(screen.getByText("Starter")).toBeInTheDocument();
    expect(screen.getByText("3 credits/mo")).toBeInTheDocument();
    expect(screen.getByText("1 credit/mo")).toBeInTheDocument();
    // No pricing EDIT controls anywhere on the org admin page — that's the
    // separate operator-only surface.
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
  });

  it("shows the low-balance banner when the org balance is zero", async () => {
    h.billingBalance.mockResolvedValue({ orgId: "org-1", balance: 0 });
    h.billingLedger.mockResolvedValue([]);
    h.billingPackages.mockResolvedValue([]);
    h.billingPricing.mockResolvedValue([]);

    renderBilling();
    await waitFor(() => expect(screen.getByText(/low balance/i)).toBeInTheDocument());
  });

  it("shows an error state when the API call fails", async () => {
    h.billingBalance.mockRejectedValue(new Error("network error"));
    h.billingLedger.mockResolvedValue([]);
    h.billingPackages.mockResolvedValue([]);
    h.billingPricing.mockResolvedValue([]);

    renderBilling();
    await waitFor(() => expect(screen.getByText(/couldn't load billing information/i)).toBeInTheDocument());
  });

  it("explains the freemium model and never calls the API when billingBase is not configured", () => {
    configMock.billingBase = undefined;
    renderBilling();
    expect(
      screen.getByText("BlissWork currently operates on a freemium model. Billing and paid plans are not available in this version."),
    ).toBeInTheDocument();
    expect(h.billingBalance).not.toHaveBeenCalled();
  });
});
