/**
 * Leaving an org when the identity has MFA enrolled: the server answers 403
 * "re-authentication required" until the request carries password + a current
 * second factor. The button must ask for it once, retry with it, keep the prompt
 * open on a wrong credential (401) or lockout (429), and behave exactly as
 * before for someone without MFA (no body, no prompt).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ApiError, type OrgMembershipDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({
  api: { myOrgs: vi.fn(), leaveOrg: vi.fn() },
  switchOrg: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {}, ws: {} }) }));
vi.mock("./OrgSwitcher", () => ({ useSwitchOrg: () => h.switchOrg }));
vi.mock("sonner", () => ({ toast: { error: h.toastError, success: h.toastSuccess } }));

import { LeaveOrgButton } from "./LeaveOrgButton";

const ORG = { orgId: "org-b", orgName: "Beta", active: false } as unknown as OrgMembershipDTO;
const OTHER = { orgId: "org-a", orgName: "Alpha", active: true } as unknown as OrgMembershipDTO;
const REAUTH = new ApiError(403, "re-authentication required");

function renderButton() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <LeaveOrgButton org={ORG} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Leave" }));
  await user.click(await screen.findByRole("button", { name: "Leave organization" }));
}

// The confirm dialog can still be animating out, with its own "Leave organization"
// button, while the prompt is up — so the prompt's submit is found inside its form.
const stepUpSubmit = () =>
  within(screen.getByPlaceholderText("Your password").closest("form")!).getByRole("button", { name: "Leave organization" });

async function fillStepUp(user: ReturnType<typeof userEvent.setup>, code = "123456") {
  await user.type(await screen.findByPlaceholderText("Your password"), "pw-123");
  await user.type(screen.getByPlaceholderText("Authentication code"), code);
  await user.click(stepUpSubmit());
}

beforeEach(() => {
  h.api.myOrgs.mockReset();
  h.api.myOrgs.mockResolvedValue([OTHER, ORG]);
  h.api.leaveOrg.mockReset();
  h.switchOrg.mockReset();
  h.toastError.mockReset();
  h.toastSuccess.mockReset();
});

describe("LeaveOrgButton step-up", () => {
  it("leaves straight away, with no body and no prompt, when the server asks for nothing", async () => {
    h.api.leaveOrg.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderButton();

    await openConfirm(user);

    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    expect(h.api.leaveOrg).toHaveBeenCalledOnce();
    expect(h.api.leaveOrg.mock.calls[0]).toEqual(expect.arrayContaining(["org-b"]));
    expect(h.api.leaveOrg.mock.calls[0]![1]).toBeUndefined();
    expect(screen.queryByPlaceholderText("Your password")).toBeNull();
  });

  it("on 403 re-authentication required, asks for password + code and retries with them", async () => {
    h.api.leaveOrg.mockRejectedValueOnce(REAUTH).mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderButton();

    await openConfirm(user);
    await fillStepUp(user);

    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    expect(h.api.leaveOrg).toHaveBeenCalledTimes(2);
    expect(h.api.leaveOrg.mock.calls[0]![1]).toBeUndefined();
    expect(h.api.leaveOrg).toHaveBeenNthCalledWith(2, "org-b", { password: "pw-123", totpCode: "123456" });
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it("sends a backup code when the user switches to one", async () => {
    h.api.leaveOrg.mockRejectedValueOnce(REAUTH).mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderButton();

    await openConfirm(user);
    await user.click(await screen.findByRole("button", { name: "Use a backup code instead" }));
    await user.type(screen.getByPlaceholderText("Your password"), "pw-123");
    await user.type(screen.getByPlaceholderText("Backup code"), "abcde-fghij");
    await user.click(stepUpSubmit());

    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    expect(h.api.leaveOrg).toHaveBeenLastCalledWith("org-b", { password: "pw-123", backupCode: "abcde-fghij" });
  });

  it("keeps the prompt open and says verification failed on a wrong credential (401)", async () => {
    h.api.leaveOrg
      .mockRejectedValueOnce(REAUTH)
      .mockRejectedValueOnce(new ApiError(401, "re-authentication failed"))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderButton();

    await openConfirm(user);
    await fillStepUp(user, "000000");

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith("Verification failed", expect.anything()));
    expect(h.toastSuccess).not.toHaveBeenCalled();
    // Still there for another try.
    const code = screen.getByPlaceholderText("Authentication code");
    await user.clear(code);
    await user.type(code, "654321");
    await user.click(stepUpSubmit());

    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    expect(h.api.leaveOrg).toHaveBeenLastCalledWith("org-b", { password: "pw-123", totpCode: "654321" });
  });

  it("says too many attempts when the identity is locked (429)", async () => {
    h.api.leaveOrg.mockRejectedValueOnce(REAUTH).mockRejectedValueOnce(new ApiError(429, "locked"));
    const user = userEvent.setup();
    renderButton();

    await openConfirm(user);
    await fillStepUp(user);

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith("Too many attempts", expect.anything()));
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it("does not prompt for a 403 that is not about re-authentication", async () => {
    h.api.leaveOrg.mockRejectedValue(new ApiError(403, "cannot leave organizations"));
    const user = userEvent.setup();
    renderButton();

    await openConfirm(user);

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith("Couldn't leave organization", expect.anything()));
    expect(screen.queryByPlaceholderText("Your password")).toBeNull();
  });

  it("still shows the server's refusal verbatim (409 last admin) after the step-up", async () => {
    h.api.leaveOrg.mockRejectedValueOnce(REAUTH).mockRejectedValueOnce(new ApiError(409, "You are the last admin"));
    const user = userEvent.setup();
    renderButton();

    await openConfirm(user);
    await fillStepUp(user);

    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith("Couldn't leave organization", { description: "You are the last admin" }),
    );
  });
});
