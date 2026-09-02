/**
 * The Organizations page.
 *
 * Two bugs pinned here:
 *  - a switch that actually redirected to /mfa-challenge (the target org
 *    requires a second factor) must not show "Switched organization" — the
 *    user hasn't switched, they're mid-challenge.
 *  - Switch must stay disabled while a Leave on this same page is still
 *    resolving, so a switch cannot land first, clear the query cache, and
 *    navigate away out from under a leave that hasn't finished.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { OrgMembershipDTO } from "@taskboard/shared";
import { toast } from "sonner";

const api = { myOrgs: vi.fn(), switchOrg: vi.fn(), leaveOrg: vi.fn() };
const setSession = vi.fn();
const clearSession = vi.fn();

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: { kind: "web" } }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../store/session", () => ({
  useSession: (select: (s: unknown) => unknown) =>
    select({
      user: { id: "u1", orgId: "org-a", orgName: "Acme", roles: ["member"] },
      setSession,
      clear: clearSession,
    }),
}));

import { Org } from "./Org";

const ACME: OrgMembershipDTO = { orgId: "org-a", orgName: "Acme", roles: ["member"], active: true };
const GLOBEX: OrgMembershipDTO = { orgId: "org-b", orgName: "Globex", roles: ["member"], active: false };

function renderOrg() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <Org />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.myOrgs.mockResolvedValue([ACME, GLOBEX]);
});

describe("switching organizations from the Organizations page", () => {
  it("does not show a success toast when the target org requires MFA", async () => {
    api.switchOrg.mockResolvedValue({
      mfaRequired: true,
      pendingToken: "tok",
      methods: ["totp"],
      enrollmentRequired: false,
    });
    const user = userEvent.setup();
    renderOrg();

    await user.click(await screen.findByRole("button", { name: "Switch" }));

    await waitFor(() => expect(api.switchOrg).toHaveBeenCalledWith("org-b"));
    // Redirected to /mfa-challenge instead — nothing to celebrate yet.
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows the success toast once the switch actually completes", async () => {
    api.switchOrg.mockResolvedValue({
      user: { id: "u1", orgId: "org-b", orgName: "Globex", roles: ["member"] },
      accessToken: "at",
      expiresIn: 900,
    });
    const user = userEvent.setup();
    renderOrg();

    await user.click(await screen.findByRole("button", { name: "Switch" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Switched organization"));
  });
});

describe("mutual exclusion with an in-flight leave", () => {
  it("disables Switch while a Leave on this page is still resolving", async () => {
    let resolveLeave: (() => void) | undefined;
    api.leaveOrg.mockImplementation(
      () => new Promise<void>((resolve) => { resolveLeave = resolve; }),
    );
    const user = userEvent.setup();
    renderOrg();

    // Both rows offer a Leave button (there are two orgs); the second one
    // (index 1) belongs to Globex, the org being left here.
    const leaveButtons = await screen.findAllByRole("button", { name: "Leave" });
    await user.click(leaveButtons[1]!);
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: /Leave organization/ }));

    await waitFor(() => expect(api.leaveOrg).toHaveBeenCalledWith("org-b"));
    expect(screen.getByRole("button", { name: "Switch" })).toBeDisabled();

    resolveLeave?.();
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch" })).not.toBeDisabled());
    // Globex wasn't the active org, so leaving it never triggers a switch.
    expect(api.switchOrg).not.toHaveBeenCalled();
  });
});
