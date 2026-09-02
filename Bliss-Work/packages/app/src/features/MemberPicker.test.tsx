/**
 * Regression coverage: MemberPicker's "Send organization" button is the app's
 * one org-wide broadcast action. usePeopleCandidates deliberately exposes
 * both `all` (self/exclude-filtered only — the pool an org-wide action should
 * target, per its own doc comment) and `candidates` (further narrowed by the
 * live search query). This button used to call onOrganization with
 * `candidates`, so typing a search term before clicking it silently shrank
 * who actually received the broadcast, with a success toast that gave no
 * indication anything was scoped down.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UserDTO } from "@taskboard/shared";
import { useSession } from "../store/session";

const ME = { id: "me-1", username: "me", displayName: "Me", email: "me@acme.test" } as UserDTO;
const ALICE = { id: "u-alice", username: "alice", displayName: "Alice", email: "alice@acme.test" } as UserDTO;
const BOB = { id: "u-bob", username: "bob", displayName: "Bob", email: "bob@acme.test" } as UserDTO;
const CARL = { id: "u-carl", username: "carl", displayName: "Carl", email: "carl@acme.test" } as UserDTO;
const DIRECTORY = [ME, ALICE, BOB, CARL];

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: { directory: () => Promise.resolve(DIRECTORY) } }),
}));

import { MemberPicker } from "./MemberPicker";

function renderPicker(onOrganization = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onOrganization,
    ...render(
      <QueryClientProvider client={qc}>
        <MemberPicker
          exclude={new Set()}
          onConfirm={() => {}}
          onCancel={() => {}}
          onOrganization={onOrganization}
        />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  useSession.getState().setSession({ user: ME, accessToken: "at", expiresIn: 900 });
});

describe("MemberPicker: Send organization", () => {
  it("targets every eligible member, not just the ones matching a live search", async () => {
    const user = userEvent.setup();
    const { onOrganization } = renderPicker();

    await screen.findByText("Alice");
    await user.type(screen.getByPlaceholderText("Search teammates…"), "alice");
    // Confirms the search is genuinely live and narrowing the visible list —
    // the bug being guarded against is that "Send organization" nonetheless
    // ignores this narrowing.
    expect(screen.queryByText("Bob")).toBeNull();
    expect(screen.queryByText("Carl")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Send organization" }));

    expect(onOrganization).toHaveBeenCalledTimes(1);
    const sentIds = (onOrganization.mock.calls[0]![0] as string[]).slice().sort();
    expect(sentIds).toEqual([ALICE.id, BOB.id, CARL.id].sort());
  });

  it("still offers Send organization, and still targets everyone, when the search matches nobody", async () => {
    const user = userEvent.setup();
    const { onOrganization } = renderPicker();

    await screen.findByText("Alice");
    await user.type(screen.getByPlaceholderText("Search teammates…"), "zzz-no-such-person");
    expect(await screen.findByText("Everyone matching is already here.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Send organization" }));

    expect(onOrganization).toHaveBeenCalledTimes(1);
    const sentIds = (onOrganization.mock.calls[0]![0] as string[]).slice().sort();
    expect(sentIds).toEqual([ALICE.id, BOB.id, CARL.id].sort());
  });
});
