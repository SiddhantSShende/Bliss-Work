/**
 * Leaving an organization from the Organizations page.
 *
 * The case worth pinning is leaving the org you are CURRENTLY in: the server
 * revokes every session that membership held, so a client that stays put is one
 * request away from a 401. Switching to a remaining org is what makes the
 * button safe, and it is invisible in the UI — nothing on screen says it
 * happened, which is exactly why it needs a test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ApiError, type OrgMembershipDTO } from "@taskboard/shared";
import { toast } from "sonner";

const api = { myOrgs: vi.fn(), leaveOrg: vi.fn() };
const switchOrg = vi.fn();
const clearSession = vi.fn();
const broadcastLogout = vi.fn();

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: { kind: "web" } }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./OrgSwitcher", () => ({ useSwitchOrg: () => switchOrg }));
vi.mock("../lib/authChannel", () => ({ broadcastLogout: () => broadcastLogout() }));
vi.mock("../store/session", () => ({
  useSession: (select: (s: unknown) => unknown) =>
    select({ user: { id: "u1", orgId: "org-a", orgName: "Acme" }, clear: clearSession }),
}));

import { LeaveOrgButton } from "./LeaveOrgButton";

const ACME: OrgMembershipDTO = { orgId: "org-a", orgName: "Acme", roles: ["member"], active: true };
const GLOBEX: OrgMembershipDTO = { orgId: "org-b", orgName: "Globex", roles: ["member"], active: false };

function renderFor(org: OrgMembershipDTO, onBusyChange?: (busy: boolean) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <LeaveOrgButton org={org} onBusyChange={onBusyChange} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** Click "Leave", then confirm in the dialog. */
async function leave(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Leave" }));
  await screen.findByRole("dialog");
  await user.click(screen.getByRole("button", { name: /Leave organization/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  api.myOrgs.mockResolvedValue([ACME, GLOBEX]);
  api.leaveOrg.mockResolvedValue(undefined);
});

describe("LeaveOrgButton", () => {
  it("asks for confirmation before leaving anything", async () => {
    const user = userEvent.setup();
    renderFor(GLOBEX);
    await user.click(screen.getByRole("button", { name: "Leave" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Leave Globex?");
    expect(api.leaveOrg).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.leaveOrg).not.toHaveBeenCalled();
  });

  it("leaves an org you are not signed in to, without switching", async () => {
    const user = userEvent.setup();
    renderFor(GLOBEX);
    await leave(user);

    await waitFor(() => expect(api.leaveOrg).toHaveBeenCalledWith("org-b"));
    expect(switchOrg).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("You left Globex");
  });

  it("switches to a remaining org after leaving the active one", async () => {
    const user = userEvent.setup();
    renderFor(ACME);
    await leave(user);

    await waitFor(() => expect(api.leaveOrg).toHaveBeenCalledWith("org-a"));
    // The session for org-a died with the membership; staying would 401.
    await waitFor(() => expect(switchOrg).toHaveBeenCalledWith("org-b"));
  });

  it("shows the server's refusal rather than a generic failure", async () => {
    api.leaveOrg.mockRejectedValue(
      new ApiError(409, "you are the last admin — promote someone else before leaving"),
    );
    const user = userEvent.setup();
    renderFor(GLOBEX);
    await leave(user);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't leave organization", {
        description: "you are the last admin — promote someone else before leaving",
      }),
    );
    expect(switchOrg).not.toHaveBeenCalled();
    // Still open, so the reason is readable next to the button that caused it.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("signs out rather than stranding the client when the follow-up switch fails", async () => {
    switchOrg.mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    renderFor(ACME);
    await leave(user);

    // The session in hand belongs to a membership that no longer exists, so the
    // only honest end state is signed out — anything else defers a bare 401.
    await waitFor(() => expect(clearSession).toHaveBeenCalled());
    expect(broadcastLogout).toHaveBeenCalled();
    // The leave itself succeeded — say so, and say what broke afterwards.
    expect(toast.success).toHaveBeenCalledWith("You left Acme");
    expect(toast.error).toHaveBeenCalledWith("Signed out", {
      description: "Please sign in again to continue.",
    });
  });

  it("signs out when there is no remaining org to fall back to", async () => {
    // Shouldn't happen — the server refuses to let anyone leave their last org —
    // but a stale myOrgs cache must not leave the tab on a dead session.
    api.myOrgs.mockResolvedValue([ACME]);
    const user = userEvent.setup();
    renderFor(ACME);
    await leave(user);

    await waitFor(() => expect(clearSession).toHaveBeenCalled());
    expect(switchOrg).not.toHaveBeenCalled();
  });

  it("reports its own in-flight leave up to the parent, so Org.tsx can disable Switch", async () => {
    // Org.tsx has nothing else to observe here — leaveOrg + the fallback
    // switchOrg call are both internal to this component — so onBusyChange
    // is the only way it can learn a leave is still resolving.
    let resolveLeave: (() => void) | undefined;
    api.leaveOrg.mockImplementation(
      () => new Promise<void>((resolve) => { resolveLeave = resolve; }),
    );
    const onBusyChange = vi.fn();
    const user = userEvent.setup();
    renderFor(GLOBEX, onBusyChange);

    await user.click(screen.getByRole("button", { name: "Leave" }));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: /Leave organization/ }));

    await waitFor(() => expect(onBusyChange).toHaveBeenCalledWith(true));
    expect(onBusyChange).not.toHaveBeenCalledWith(false);

    resolveLeave?.();
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  });
});
