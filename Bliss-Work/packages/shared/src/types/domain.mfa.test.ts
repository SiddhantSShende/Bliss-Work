import { describe, expect, it } from "vitest";
import { LoginResult, MfaPendingDTO, SessionDTO, UserDTO, isMfaPending } from "./domain";

const USER: UserDTO = {
  id: "11111111-1111-1111-1111-111111111111",
  orgId: "22222222-2222-2222-2222-222222222222",
  orgName: "Acme",
  username: "alice",
  displayName: "Alice",
  email: "alice@acme.com",
  roles: ["member"],
  plan: "free",
  avatarUrl: null,
  mfaEnrolled: false,
  orgRequireMfaForAdmins: false,
  orgMfaGracePeriodEndsAt: null,
};

const SESSION: SessionDTO = { accessToken: "tok", user: USER, expiresIn: 300 };

describe("isMfaPending", () => {
  it("is false for an ordinary session", () => {
    expect(isMfaPending(SESSION)).toBe(false);
  });

  it("is true for a pending-MFA response", () => {
    const pending: MfaPendingDTO = {
      mfaRequired: true,
      pendingToken: "raw-token",
      methods: ["totp"],
      enrollmentRequired: false,
    };
    expect(isMfaPending(pending)).toBe(true);
  });

  it("LoginResult parses a real session response", () => {
    const parsed = LoginResult.parse(SESSION);
    expect(isMfaPending(parsed)).toBe(false);
  });

  it("LoginResult parses a real MFA-pending response and defaults enrollmentRequired", () => {
    const parsed = LoginResult.parse({
      mfaRequired: true,
      pendingToken: "raw-token",
      methods: ["totp", "webauthn"],
    });
    expect(isMfaPending(parsed)).toBe(true);
    if (isMfaPending(parsed)) {
      expect(parsed.enrollmentRequired).toBe(false);
      expect(parsed.methods).toEqual(["totp", "webauthn"]);
    }
  });
});
