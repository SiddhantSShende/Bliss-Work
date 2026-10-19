import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ApiError } from "@taskboard/shared";

const h = vi.hoisted(() => ({
  billingPricing: vi.fn(),
  billingPackages: vi.fn(),
  billingUpdatePricing: vi.fn(),
  billingCreatePackage: vi.fn(),
  billingUpdatePackage: vi.fn(),
}));
vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: h, config: { billingBase: "http://billing.test" } }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { OperatorPricing } from "./OperatorPricing";

const PRICING = [
  { key: "admin_monthly_credits", value: 3, updatedAt: "2026-01-01T00:00:00Z", updatedBy: null },
  { key: "member_monthly_credits", value: 1, updatedAt: "2026-01-01T00:00:00Z", updatedBy: null },
  { key: "admin_reference_price_cents", value: 800, updatedAt: "2026-01-01T00:00:00Z", updatedBy: null },
  { key: "member_reference_price_cents", value: 500, updatedAt: "2026-01-01T00:00:00Z", updatedBy: null },
  { key: "admin_current_price_cents", value: 300, updatedAt: "2026-01-01T00:00:00Z", updatedBy: null },
  { key: "member_current_price_cents", value: 100, updatedAt: "2026-01-01T00:00:00Z", updatedBy: null },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OperatorPricing />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("OperatorPricing", () => {
  it("a platform operator can view and save pricing successfully", async () => {
    h.billingPricing.mockResolvedValue(PRICING);
    h.billingPackages.mockResolvedValue([]);
    h.billingUpdatePricing.mockResolvedValue({ ...PRICING[4], value: 250 });

    renderPage();
    await waitFor(() => expect(screen.getByText("Admin current price (cents)")).toBeInTheDocument());

    const user = userEvent.setup();
    const row = screen.getByText("Admin current price (cents)").closest("div")!;
    const input = row.querySelector("input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "250");
    await user.click(within(row).getByRole("button", { name: /save/i }));

    await waitFor(() => expect(h.billingUpdatePricing).toHaveBeenCalledWith("admin_current_price_cents", 250));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("surfaces a clear error when a write is rejected with 403 (not a platform operator)", async () => {
    h.billingPricing.mockResolvedValue(PRICING);
    h.billingPackages.mockResolvedValue([]);
    h.billingUpdatePricing.mockRejectedValue(new ApiError(403, "platform operator role required"));

    renderPage();
    await waitFor(() => expect(screen.getByText("Admin monthly credits")).toBeInTheDocument());

    const user = userEvent.setup();
    const row = screen.getByText("Admin monthly credits").closest("div")!;
    await user.click(within(row).getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/platform operator/i)),
    );
  });

  it("renders package create/edit controls regardless of role — the backend is the gate", async () => {
    h.billingPricing.mockResolvedValue(PRICING);
    h.billingPackages.mockResolvedValue([
      { id: "p1", name: "Starter", credits: 100, priceCents: 10000, currency: "usd", active: true },
    ]);

    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue("Starter")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /add package/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deactivate/i })).toBeInTheDocument();
  });

  it("shows an error state when pricing fails to load", async () => {
    h.billingPricing.mockRejectedValue(new Error("boom"));
    h.billingPackages.mockResolvedValue([]);

    renderPage();
    await waitFor(() => expect(screen.getByText(/couldn't load pricing/i)).toBeInTheDocument());
  });
});
