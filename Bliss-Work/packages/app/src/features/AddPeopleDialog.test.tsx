/**
 * Regression coverage for the desktop "Join the meeting: file:///join?t=..."
 * bug: the link this dialog sends used to be built from window.location.origin,
 * which is the opaque file:// origin on the packaged Electron renderer. It must
 * come from config.webBaseUrl instead — see lib/meetingDeepLink.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  createCallInvite: vi.fn(async () => ({ token: "tok-1" })),
  sendMessage: vi.fn(async () => ({})),
}));

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({
    api: { createCallInvite: h.createCallInvite, sendMessage: h.sendMessage },
    config: { webBaseUrl: "https://communication.rnrtechs.com" },
  }),
}));

vi.mock("../store/session", () => ({
  useSession: (sel: (s: unknown) => unknown) => sel({ user: { id: "me", roles: [] } }),
}));

// Isolates this test from the real directory/search UI — onConfirm is the
// only thing sendLink's link-building logic depends on.
vi.mock("./MemberPicker", () => ({
  MemberPicker: ({ onConfirm }: { onConfirm: (ids: string[]) => void }) => (
    <button onClick={() => onConfirm(["u-1"])}>confirm-picker</button>
  ),
}));

import { AddPeopleDialog } from "./AddPeopleDialog";

it("builds the meeting link from config.webBaseUrl, never window.location.origin", async () => {
  const user = userEvent.setup();
  render(
    <AddPeopleDialog
      open
      onClose={() => {}}
      exclude={new Set()}
      onAdd={async () => {}}
      callId="call-1"
    />,
  );

  await user.click(screen.getByRole("button", { name: "Send link" }));
  await user.click(screen.getByRole("button", { name: "confirm-picker" }));

  await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalled());
  expect(h.sendMessage).toHaveBeenCalledWith(
    "u-1",
    "Join the meeting: https://communication.rnrtechs.com/join?t=tok-1",
  );
});
