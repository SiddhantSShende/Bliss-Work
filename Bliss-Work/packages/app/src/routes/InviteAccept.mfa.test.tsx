/**
 * acceptInvite for an identity with MFA enrolled answers with the same pending
 * challenge /auth/login does (the membership IS created; the challenge signs
 * them into it). InviteAccept must hand it to /mfa-challenge and must NOT adopt
 * a session it was not given. A plain session still lands on /app.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const h = vi.hoisted(() => ({
  api: { verifyInvite: vi.fn(), acceptInvite: vi.fn() },
  broadcast: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("../lib/authChannel", () => ({ broadcastSession: h.broadcast }));
vi.mock("sonner", () => ({ toast: { error: h.toastError, success: vi.fn() } }));

import { InviteAccept } from "./InviteAccept";
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
    <MemoryRouter initialEntries={["/invite?token=inv-1"]}>
      <Routes>
        <Route path="/invite" element={<InviteAccept />} />
        <Route path="/mfa-challenge" element={<Challenge />} />
        <Route path="/app" element={<div>signed in</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText("Invited as sam@example.com");
  await user.type(screen.getByPlaceholderText("ada"), "sam");
  await user.type(screen.getByPlaceholderText("Ada Lovelace"), "Sam");
  await user.type(screen.getByPlaceholderText("••••••••"), "correct-horse-9!");
  await user.click(screen.getByRole("button", { name: "Join workspace" }));
}

beforeEach(() => {
  h.api.verifyInvite.mockReset();
  h.api.verifyInvite.mockResolvedValue({ email: "sam@example.com", orgName: "Acme", valid: true });
  h.api.acceptInvite.mockReset();
  h.broadcast.mockReset();
  h.toastError.mockReset();
  useSession.setState({ user: null, accessToken: null } as never);
});

describe("InviteAccept acceptInvite result", () => {
  it("sends an MFA-enrolled identity to /mfa-challenge with the pending token, without adopting a session", async () => {
    h.api.acceptInvite.mockResolvedValue(PENDING);

    await submitForm();

    expect(await screen.findByText("challenge:pend-1:totp")).toBeInTheDocument();
    expect(h.api.acceptInvite).toHaveBeenCalledWith({
      token: "inv-1",
      username: "sam",
      displayName: "Sam",
      password: "correct-horse-9!",
    });
    expect(useSession.getState().accessToken).toBeNull();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it("still signs in and lands on /app when a session comes back", async () => {
    h.api.acceptInvite.mockResolvedValue(SESSION);

    await submitForm();

    expect(await screen.findByText("signed in")).toBeInTheDocument();
    await waitFor(() => expect(useSession.getState().accessToken).toBe("token"));
    expect(h.broadcast).toHaveBeenCalledWith(SESSION);
  });
});
