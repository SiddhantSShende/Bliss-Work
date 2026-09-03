/**
 * MfaSettings: the three fixes from this review that are actually testable
 * from outside the component —
 *
 *   - Bug 1: the step-up modal (disable / regenerate backup codes) offers a
 *     passkey option to a user who has one registered, and a rejected/
 *     replayed assertion surfaces an error rather than silently disabling
 *     MFA anyway.
 *   - Bug 2: the backup-codes modal registers a `beforeunload` guard while
 *     the codes are showing and unacknowledged, and removes it once the user
 *     acknowledges and closes it.
 *   - Bug 3: a failed follow-up `api.me()` after an MFA mutation surfaces a
 *     toast instead of silently leaving the page on stale MFA status.
 *
 * This is NOT a full test of the page — see the file's own doc comment for
 * what it does and does not track (still no full per-credential listing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ApiError, type UserDTO } from "@taskboard/shared";
import { toast } from "sonner";

const api = {
  me: vi.fn(),
  mfaMethods: vi.fn(),
  mfaDisable: vi.fn(),
  mfaRegenerateBackupCodes: vi.fn(),
  mfaWebauthnStepUpStart: vi.fn(),
  mfaWebauthnRegisterStart: vi.fn(),
  mfaWebauthnRegisterFinish: vi.fn(),
};
const setUser = vi.fn();
let currentUser: UserDTO;

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: { kind: "web" } }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../store/session", () => ({
  useSession: (select: (s: unknown) => unknown) => select({ user: currentUser, setUser }),
}));
vi.mock("../lib/webauthn", () => ({
  webauthnSupported: () => true,
  getPasskeyAssertion: vi.fn(),
  createPasskey: vi.fn(),
}));

import { MfaSettings } from "./MfaSettings";
import { createPasskey, getPasskeyAssertion } from "../lib/webauthn";

function baseUser(over: Partial<UserDTO> = {}): UserDTO {
  return {
    id: "u1",
    orgId: "org-a",
    orgName: "Acme",
    username: "sid",
    displayName: "Sid",
    email: "sid@example.com",
    roles: ["member"],
    emailVerified: true,
    plan: "free",
    avatarUrl: null,
    mfaEnrolled: true,
    orgRequireMfaForAdmins: false,
    orgMfaGracePeriodEndsAt: null,
    ...over,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <MfaSettings />
    </MemoryRouter>,
  );
}

/** Opens the step-up modal and fills in the password field — the shared
 *  first half of both the code/backup-code path and the passkey path. */
async function openStepUp(user: ReturnType<typeof userEvent.setup>, buttonName: RegExp | string) {
  await user.click(await screen.findByRole("button", { name: buttonName }));
  await screen.findByRole("dialog");
  await user.type(screen.getByPlaceholderText("Your password"), "hunter2");
}

/** Fills the "Authentication code" field with a whole value in one event
 *  rather than `userEvent.type`'s per-keystroke simulation: this field isn't
 *  what's under test here (the code/backup-code path itself is pre-existing
 *  behavior, unchanged by this review), and firing one `change` avoids
 *  interference from the dialog's own focus-management effect re-running on
 *  every keystroke's re-render — a pre-existing characteristic of Modal's
 *  focus trap that is out of this review's scope to touch. */
function fillCode(value: string) {
  fireEvent.change(screen.getByPlaceholderText("Authentication code"), { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = baseUser();
  // Every render fetches this once MFA is enrolled — default to "no passkey"
  // so tests that don't care about it don't crash on an unmocked call.
  api.mfaMethods.mockResolvedValue({ methods: ["totp"] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MfaSettings — passkey step-up (Bug 1)", () => {
  it("offers a passkey option once the user's registered methods include webauthn", async () => {
    api.mfaMethods.mockResolvedValue({ methods: ["totp", "webauthn"] });
    const user = userEvent.setup();
    renderPage();
    await openStepUp(user, "Turn off");
    expect(await screen.findByRole("button", { name: /use a passkey instead/i })).toBeTruthy();
  });

  it("does not offer a passkey option when the user has none registered", async () => {
    api.mfaMethods.mockResolvedValue({ methods: ["totp"] });
    const user = userEvent.setup();
    renderPage();
    await openStepUp(user, "Turn off");
    await waitFor(() => expect(api.mfaMethods).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /use a passkey instead/i })).toBeNull();
  });

  it("disables MFA via a WebAuthn assertion — the only path a passkey-only enrollee has", async () => {
    api.mfaMethods.mockResolvedValue({ methods: ["webauthn"] });
    api.mfaWebauthnStepUpStart.mockResolvedValue({ challenge: "c" });
    (getPasskeyAssertion as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cred1" });
    api.mfaDisable.mockResolvedValue(undefined);
    api.me.mockResolvedValue(currentUser);
    const user = userEvent.setup();
    renderPage();
    await openStepUp(user, "Turn off");
    await user.click(await screen.findByRole("button", { name: /use a passkey instead/i }));

    await waitFor(() =>
      expect(api.mfaDisable).toHaveBeenCalledWith({
        password: "hunter2",
        webauthnCredential: { id: "cred1" },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Two-factor authentication turned off");
  });

  it("shows an error and does NOT disable MFA when the assertion is rejected (wrong/replayed passkey)", async () => {
    api.mfaMethods.mockResolvedValue({ methods: ["webauthn"] });
    api.mfaWebauthnStepUpStart.mockResolvedValue({ challenge: "c" });
    (getPasskeyAssertion as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cred1" });
    api.mfaDisable.mockRejectedValue(new ApiError(401, "re-authentication failed"));
    const user = userEvent.setup();
    renderPage();
    await openStepUp(user, "Turn off");
    await user.click(await screen.findByRole("button", { name: /use a passkey instead/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't verify passkey", { description: "Please try again." }),
    );
    // Still open, and MFA was never actually reported as turned off.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("MfaSettings — adding a passkey to an already-enrolled account requires step-up (Bug 4)", () => {
  it("verifies step-up, then runs a fresh WebAuthn registration ceremony and reports it as a new credential", async () => {
    api.mfaWebauthnRegisterStart.mockResolvedValue({ challenge: "c2" });
    (createPasskey as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "newcred" });
    api.mfaWebauthnRegisterFinish.mockResolvedValue({ id: "newcred" });
    api.me.mockResolvedValue(currentUser);
    const user = userEvent.setup();
    renderPage();
    await openStepUp(user, "Add");
    fillCode("123456");
    await user.click(screen.getByRole("button", { name: "Add passkey" }));

    await waitFor(() =>
      expect(api.mfaWebauthnRegisterFinish).toHaveBeenCalledWith({
        credential: { id: "newcred" },
        stepUp: { password: "hunter2", totpCode: "123456" },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Passkey added");
  });

  it("does not run the registration ceremony when step-up verification itself fails", async () => {
    api.mfaWebauthnRegisterFinish.mockRejectedValue(new ApiError(401, "re-authentication failed"));
    (createPasskey as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "newcred" });
    const user = userEvent.setup();
    renderPage();
    await openStepUp(user, "Add");
    fillCode("000000");
    await user.click(screen.getByRole("button", { name: "Add passkey" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Verification failed", {
        description: "Check your password and code, then try again.",
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("MfaSettings — backup codes leave-page guard (Bug 2)", () => {
  it("registers a beforeunload guard while codes are unacknowledged, and removes it once the user is done", async () => {
    api.mfaRegenerateBackupCodes.mockResolvedValue({ backupCodes: ["a1b2c-3d4e5", "f6g7h-8i9j0"] });
    api.me.mockResolvedValue(currentUser);
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const user = userEvent.setup();
    renderPage();
    await openStepUp(user, "Regenerate");
    fillCode("123456");
    await user.click(screen.getByRole("button", { name: "Regenerate backup codes" }));
    await screen.findByText(/save your backup codes/i);

    expect(addSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    const handler = addSpy.mock.calls.find(([type]) => type === "beforeunload")?.[1];
    expect(handler).toBeTruthy();
    expect(removeSpy).not.toHaveBeenCalledWith("beforeunload", handler);

    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(removeSpy).toHaveBeenCalledWith("beforeunload", handler);
  });
});

describe("MfaSettings — refreshUser() after a mutation surfaces a failed refetch (Bug 3)", () => {
  async function regenerateAndFinish(user: ReturnType<typeof userEvent.setup>) {
    api.mfaRegenerateBackupCodes.mockResolvedValue({ backupCodes: ["a1b2c-3d4e5"] });
    renderPage();
    await openStepUp(user, "Regenerate");
    fillCode("123456");
    await user.click(screen.getByRole("button", { name: "Regenerate backup codes" }));
    await screen.findByText(/save your backup codes/i);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Done" }));
  }

  it("surfaces a toast (after one retry) when the follow-up api.me() keeps failing", async () => {
    api.me.mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    await regenerateAndFinish(user);

    await waitFor(() => expect(api.me).toHaveBeenCalledTimes(2));
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't refresh your account",
      expect.objectContaining({ description: expect.stringContaining("out of date") }),
    );
    expect(setUser).not.toHaveBeenCalled();
  });

  it("does not show an error toast when the follow-up refetch succeeds (possibly after one retry)", async () => {
    api.me.mockResolvedValueOnce(currentUser);
    const user = userEvent.setup();
    await regenerateAndFinish(user);

    await waitFor(() => expect(setUser).toHaveBeenCalledWith(currentUser));
    expect(toast.error).not.toHaveBeenCalledWith(
      "Couldn't refresh your account",
      expect.anything(),
    );
  });
});
