/**
 * createOrg for an identity with MFA enrolled answers with the same pending
 * challenge /auth/login does (the org IS created; the challenge signs them into
 * it). Onboarding must hand that to /mfa-challenge exactly as Login does, and
 * must NOT adopt a session it was not given. A plain session still lands on /app.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const h = vi.hoisted(() => ({
  api: { getCaptcha: vi.fn(), createOrg: vi.fn() },
  broadcast: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("../lib/authChannel", () => ({ broadcastSession: h.broadcast }));
vi.mock("sonner", () => ({ toast: { error: h.toastError, success: vi.fn() } }));

import { Onboarding } from "./Onboarding";
import { useSession } from "../store/session";

const SESSION = {
  user: { id: "u1", orgId: "o1", username: "sam", displayName: "Sam", roles: ["member"] },
  accessToken: "token",
  expiresIn: 900,
};
const PENDING = { mfaRequired: true, pendingToken: "pend-1", methods: ["totp"], enrollmentRequired: false };

function Challenge() {
  const state = useLocation().state as { pendingToken?: string; methods?: string[] } | null;
  return <div>challenge:{state?.pendingToken}:{state?.methods?.join(",")}</div>;
}

async function submitForm() {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/onboarding"]}>
      <Routes>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/mfa-challenge" element={<Challenge />} />
        <Route path="/app" element={<div>signed in</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await user.type(screen.getByPlaceholderText("Acme Inc."), "Acme");
  await user.type(screen.getByPlaceholderText("Ada Lovelace"), "Sam");
  await user.type(screen.getByPlaceholderText("you@acme.com"), "sam@example.com");
  await user.type(screen.getByPlaceholderText("••••••••"), "correct-horse-9!");
  await user.type(await screen.findByLabelText("CAPTCHA answer"), "AbCdEf");
  await user.click(screen.getByRole("button", { name: "Create organization" }));
}

beforeEach(() => {
  h.api.getCaptcha.mockReset();
  h.api.getCaptcha.mockResolvedValue({ captchaId: "cap-1", captchaImage: "data:image/png;base64,AAAA", expiresIn: 300 });
  h.api.createOrg.mockReset();
  h.broadcast.mockReset();
  h.toastError.mockReset();
  useSession.setState({ user: null, accessToken: null } as never);
});

describe("Onboarding createOrg result", () => {
  it("sends an MFA-enrolled identity to /mfa-challenge with the pending token, without adopting a session", async () => {
    h.api.createOrg.mockResolvedValue(PENDING);

    await submitForm();

    expect(await screen.findByText("challenge:pend-1:totp")).toBeInTheDocument();
    expect(useSession.getState().accessToken).toBeNull();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it("still signs in and lands on /app when a session comes back", async () => {
    h.api.createOrg.mockResolvedValue(SESSION);

    await submitForm();

    expect(await screen.findByText("signed in")).toBeInTheDocument();
    await waitFor(() => expect(useSession.getState().accessToken).toBe("token"));
    expect(h.broadcast).toHaveBeenCalledWith(SESSION);
  });
});
