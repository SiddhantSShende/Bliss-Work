/**
 * The cross-caller lock behind `useSwitchOrg`/`useOrgSwitchBusyId`.
 *
 * Before this fix, the top-bar switcher and the Organizations page each
 * tracked their own, independent `busy` flag. Nothing stopped switching to
 * org B from one and org C from the other in quick succession — whichever
 * response landed last silently won, with no error and nothing disabled to
 * stop the second click in the first place.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { OrgMembershipDTO } from "@taskboard/shared";

const api = { myOrgs: vi.fn(), switchOrg: vi.fn() };
const setSession = vi.fn();

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api }) }));
vi.mock("../store/session", () => ({
  useSession: (select: (s: unknown) => unknown) =>
    select({ user: { id: "u1", orgId: "org-a", orgName: "Acme" }, setSession }),
}));

import { OrgSwitcher, useSwitchOrg } from "./OrgSwitcher";

const ORGS: OrgMembershipDTO[] = [
  { orgId: "org-a", orgName: "Acme", roles: ["member"], active: true },
  { orgId: "org-b", orgName: "Globex", roles: ["member"], active: false },
  { orgId: "org-c", orgName: "Initech", roles: ["member"], active: false },
];

function renderTree(children: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>,
  );
}

/** Test-only stand-in for a second, independent caller of useSwitchOrg (e.g.
 *  the Organizations page), so the supersession test can drive two calls
 *  directly without needing the full page. */
function SwitchHarness() {
  const switchOrg = useSwitchOrg();
  return (
    <>
      <button onClick={() => void switchOrg("org-b")}>switch-b</button>
      <button onClick={() => void switchOrg("org-c")}>switch-c</button>
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.myOrgs.mockResolvedValue(ORGS);
});

describe("the shared switch lock", () => {
  it("disables one switcher instance's items while another's switch is in flight", async () => {
    let resolveSwitch: ((v: unknown) => void) | undefined;
    api.switchOrg.mockImplementation(() => new Promise((res) => { resolveSwitch = res; }));

    const user = userEvent.setup();
    // Two independent instances, standing in for the top-bar switcher and a
    // second surface (the Organizations page) that also offers a switch.
    const first = renderTree(<OrgSwitcher />);
    const second = renderTree(<OrgSwitcher />);

    await user.click(await within(first.container).findByTitle("Switch organization"));
    await user.click(within(first.container).getByText("Globex").closest("button")!);
    await waitFor(() => expect(api.switchOrg).toHaveBeenCalledWith("org-b"));

    // The second instance's own dropdown items are disabled too, even though
    // its switch was started entirely from the first instance.
    await user.click(await within(second.container).findByTitle("Switch organization"));
    expect(within(second.container).getByText("Globex").closest("button")).toBeDisabled();
    expect(within(second.container).getByText("Initech").closest("button")).toBeDisabled();

    resolveSwitch?.({
      user: { id: "u1", orgId: "org-b", orgName: "Globex" },
      accessToken: "at",
      expiresIn: 900,
    });
    await waitFor(() =>
      expect(within(second.container).getByText("Initech").closest("button")).not.toBeDisabled(),
    );
  });
});

describe("supersession", () => {
  it("a later switch's outcome wins even when an earlier one resolves after it", async () => {
    let resolveB: ((v: unknown) => void) | undefined;
    let resolveC: ((v: unknown) => void) | undefined;
    api.switchOrg.mockImplementation((orgId: string) => {
      if (orgId === "org-b") return new Promise((res) => { resolveB = res; });
      if (orgId === "org-c") return new Promise((res) => { resolveC = res; });
      throw new Error(`unexpected orgId ${orgId}`);
    });

    const user = userEvent.setup();
    renderTree(<SwitchHarness />);

    await user.click(screen.getByText("switch-b"));
    await user.click(screen.getByText("switch-c"));

    // C — the LATER request — resolves first.
    resolveC?.({
      user: { id: "u1", orgId: "org-c", orgName: "Initech" },
      accessToken: "at-c",
      expiresIn: 900,
    });
    await waitFor(() => expect(setSession).toHaveBeenCalledTimes(1));
    expect(setSession).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "at-c" }));

    // B's stale response arrives after. It must not clobber C's
    // already-applied session — no phantom second call.
    resolveB?.({
      user: { id: "u1", orgId: "org-b", orgName: "Globex" },
      accessToken: "at-b",
      expiresIn: 900,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(setSession).toHaveBeenCalledTimes(1);
  });
});
