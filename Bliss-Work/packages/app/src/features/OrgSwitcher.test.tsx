import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OrgMembershipDTO, UserDTO } from "@taskboard/shared";
import { useSession } from "../store/session";

const h = vi.hoisted(() => ({ api: { myOrgsPage: vi.fn() } }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { OrgSwitcher } from "./OrgSwitcher";

const org = (number: number): OrgMembershipDTO => ({
  orgId: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
  orgName: `Organization ${number}`,
  roles: ["member"],
  active: number === 1,
});

function renderSwitcher() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <OrgSwitcher />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useSession.setState({ user: { orgId: org(1).orgId, orgName: "Organization 1" } as UserDTO });
  h.api.myOrgsPage.mockReset();
  h.api.myOrgsPage.mockImplementation(({ offset }: { offset: number }) =>
    Promise.resolve(
      offset === 0
        ? { items: [org(1), org(2)], hasMore: true }
        : { items: [org(2), org(3)], hasMore: false },
    ),
  );
});

describe("OrgSwitcher", () => {
  it("fetches only when opened and appends the next page without duplicates", async () => {
    renderSwitcher();
    expect(h.api.myOrgsPage).not.toHaveBeenCalled();
    expect(screen.queryByText("Organization 2")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Organization 1/ }));
    expect(await screen.findByText("Organization 2")).toBeInTheDocument();
    expect(h.api.myOrgsPage).toHaveBeenCalledWith({ search: "", offset: 0, limit: 2 });
    expect(screen.queryByText("Organization 3")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Organization 3")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("Organization 2")).toHaveLength(1));
    expect(h.api.myOrgsPage).toHaveBeenLastCalledWith({ search: "", offset: 2, limit: 2 });
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("sends debounced search to the server from the first page", async () => {
    h.api.myOrgsPage.mockImplementation(({ search, offset }: { search: string; offset: number }) =>
      Promise.resolve(
        search === "abc"
          ? { items: [org(3)], hasMore: false }
          : { items: [org(1), org(2)], hasMore: true },
      ),
    );
    renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /Organization 1/ }));
    await screen.findByText("Organization 2");

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "abc" } });
    await waitFor(() =>
      expect(h.api.myOrgsPage).toHaveBeenLastCalledWith({ search: "abc", offset: 0, limit: 2 }),
    );
    expect(await screen.findByText("Organization 3")).toBeInTheDocument();
    expect(screen.queryByText("Organization 2")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("shows an empty state when no organizations match", async () => {
    h.api.myOrgsPage.mockResolvedValue({ items: [], hasMore: false });
    renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /Organization 1/ }));
    expect(await screen.findByText("No organizations found")).toBeInTheDocument();
  });
});