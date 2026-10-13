/**
 * Flipping the org's mandatory-MFA-for-admins toggle must refresh the
 * caller's OWN session immediately: AppShell's MfaRequiredBanner reads
 * session.user (orgRequireMfaForAdmins / orgMfaGracePeriodEndsAt), not the
 * qk.orgMfaSettings query this panel manages — without re-fetching `/auth/me`
 * after the mutation, an admin who just turned the policy on would not see
 * their own reminder banner until the next background token refresh.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "../store/session";
import { ME } from "../test/meetingFixtures";

const h = vi.hoisted(() => ({
  api: { orgMfaSettings: vi.fn(), setOrgMfaSettings: vi.fn(), me: vi.fn() },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MfaPolicySection } from "./MfaPolicySection";

const ADMIN = { ...ME, roles: ["org_admin" as const] };

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MfaPolicySection />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup() };
}

beforeEach(() => {
  useSession.setState({ user: ADMIN });
  h.api.orgMfaSettings.mockReset().mockResolvedValue({ requireMfaForAdmins: false, mfaGracePeriodEndsAt: null });
  h.api.setOrgMfaSettings.mockReset();
  h.api.me.mockReset();
});

describe("MfaPolicySection", () => {
  it("refreshes the session user after turning the policy on, so the caller's own banner updates immediately", async () => {
    const deadline = "2026-11-01T00:00:00.000Z";
    h.api.setOrgMfaSettings.mockResolvedValue({ requireMfaForAdmins: true, mfaGracePeriodEndsAt: deadline });
    h.api.me.mockResolvedValue({ ...ADMIN, orgRequireMfaForAdmins: true, orgMfaGracePeriodEndsAt: deadline });
    const { user } = mount();

    await user.click(await screen.findByRole("button", { name: /turn on/i }));

    await waitFor(() => expect(h.api.me).toHaveBeenCalledTimes(1));
    expect(useSession.getState().user?.orgRequireMfaForAdmins).toBe(true);
    expect(useSession.getState().user?.orgMfaGracePeriodEndsAt).toBe(deadline);
  });

  it("refreshes the session user after turning the policy off", async () => {
    h.api.orgMfaSettings.mockResolvedValue({ requireMfaForAdmins: true, mfaGracePeriodEndsAt: "2026-11-01T00:00:00.000Z" });
    h.api.setOrgMfaSettings.mockResolvedValue({ requireMfaForAdmins: false, mfaGracePeriodEndsAt: null });
    h.api.me.mockResolvedValue({ ...ADMIN, orgRequireMfaForAdmins: false, orgMfaGracePeriodEndsAt: null });
    useSession.setState({ user: { ...ADMIN, orgRequireMfaForAdmins: true, orgMfaGracePeriodEndsAt: "2026-11-01T00:00:00.000Z" } });
    const { user } = mount();

    await user.click(await screen.findByRole("button", { name: /turn off/i }));

    await waitFor(() => expect(h.api.me).toHaveBeenCalledTimes(1));
    expect(useSession.getState().user?.orgRequireMfaForAdmins).toBe(false);
    expect(useSession.getState().user?.orgMfaGracePeriodEndsAt).toBeNull();
  });
});
