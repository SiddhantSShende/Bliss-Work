import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AuditPage, MemberDTO } from "@taskboard/shared";

const api = {
  auditLog: vi.fn(),
};

vi.mock("../../lib/runtime", () => ({
  useRuntime: () => ({ api, config: { kind: "web" } }),
}));

import { MemberAuditLog } from "./MemberAuditLog";

function renderAuditLog(members: MemberDTO[], targetId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemberAuditLog targetId={targetId} members={members} />
    </QueryClientProvider>,
  );
}

function member(over: Partial<MemberDTO>): MemberDTO {
  return {
    id: "u-default",
    username: "default",
    displayName: "Default User",
    email: "default@acme.com",
    roles: ["member"],
    status: "active",
    emailVerified: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    removedAt: null,
    avatarUrl: null,
    ...over,
  };
}

describe("MemberAuditLog", () => {
  it("renders a distinct error state — not the empty state — when the fetch fails", async () => {
    // Regression for the client/server type mismatch: a response that fails
    // AuditPage.safeParse (or any other fetch failure) used to render exactly
    // like a genuinely empty audit trail, because the component never checked
    // isError. That made the feature look "fine, just empty" instead of
    // broken.
    api.auditLog.mockRejectedValue(new Error("invalid response from server"));

    renderAuditLog([]);

    expect(await screen.findByText("Audit log could not be loaded")).toBeTruthy();
    expect(screen.queryByText("Nothing recorded yet")).toBeNull();
  });

  it("shows the empty state, not the error state, when the fetch genuinely succeeds with no entries", async () => {
    api.auditLog.mockResolvedValue({ entries: [], nextCursor: null } satisfies AuditPage);

    renderAuditLog([]);

    expect(await screen.findByText("Nothing recorded yet")).toBeTruthy();
    expect(screen.queryByText("Audit log could not be loaded")).toBeNull();
  });

  it("names an actor who is suspended/removed (present in the full roster, not the active-only directory)", async () => {
    // Regression: MemberDetail used to pass the active-only `directory` into
    // this component, so an admin who performed an action and was later
    // suspended or removed showed as "System" instead of their real name.
    // `members` here stands in for the full roster (api.listMembers()),
    // which includes suspended/removed people — exactly what MemberDetail
    // must now pass.
    const suspendedActor = member({
      id: "u-suspended-actor",
      displayName: "Priya Suspended",
      status: "suspended",
    });

    api.auditLog.mockResolvedValue({
      entries: [
        {
          id: "018f2f6c-8b1a-7c3e-9c2a-1234567890ab",
          actorId: "u-suspended-actor",
          action: "member.role_changed",
          target: null,
          meta: { from: "member", to: "org_admin" },
          at: "2026-01-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    } satisfies AuditPage);

    renderAuditLog([suspendedActor]);

    expect(await screen.findByText("Priya Suspended")).toBeTruthy();
    expect(screen.queryByText("System")).toBeNull();
  });

  it("falls back to 'System' when the actor truly isn't in the roster at all", async () => {
    api.auditLog.mockResolvedValue({
      entries: [
        {
          id: "018f2f6c-8b1a-7c3e-9c2a-1234567890ac",
          actorId: null,
          action: "org.created",
          target: null,
          meta: null,
          at: "2026-01-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    } satisfies AuditPage);

    renderAuditLog([]);

    expect(await screen.findByText("System")).toBeTruthy();
  });
});
