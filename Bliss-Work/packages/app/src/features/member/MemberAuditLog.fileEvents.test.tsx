/**
 * File opens/downloads on the member-detail Security tab (auth-svc's audit log):
 * who, what, the file's name, and — quieter — which chat or channel it was in.
 * Other audit entries, and file entries recorded without a chat, are unchanged.
 */
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEntryDTO, MemberDTO } from "@taskboard/shared";

const mocks = vi.hoisted(() => ({ auditLog: vi.fn() }));
vi.mock("../../lib/runtime", () => ({ useRuntime: () => ({ api: { auditLog: mocks.auditLog } }) }));

import { MemberAuditLog } from "./MemberAuditLog";

const PRIYA: MemberDTO = {
  id: "u-priya",
  username: "priya",
  displayName: "Priya Sharma",
  email: "priya@example.com",
  roles: ["member"],
  status: "active",
  emailVerified: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  removedAt: null,
  avatarUrl: null,
};

let n = 0;
const entry = (action: string, meta: Record<string, unknown> | null): AuditEntryDTO => ({
  id: `audit-${++n}`,
  actorId: PRIYA.id,
  action,
  target: PRIYA.id,
  meta,
  at: "2026-10-09T10:00:00.000Z",
});

const OPENED_DM = entry("file.opened", {
  filename: "image.png",
  contextKind: "direct",
  contextId: "cv-1",
  contextName: "Divya Bhamri",
  ip: "203.0.113.9",
  platform: "desktop",
});
const DOWNLOADED_CHANNEL = entry("file.downloaded", {
  filename: "Text Extraction CSV Data Report.pdf",
  contextKind: "channel",
  contextId: "ch-1",
  contextName: "GRC Development",
});

function renderLog(entries: AuditEntryDTO[]) {
  mocks.auditLog.mockResolvedValue({ entries, nextCursor: null });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemberAuditLog targetId={PRIYA.id} members={[PRIYA]} />
    </QueryClientProvider>,
  );
}

const rowOf = (text: string) => screen.getByText(text).closest("div.flex.items-start")! as HTMLElement;

beforeEach(() => mocks.auditLog.mockReset());

describe("file events on the Security tab", () => {
  it("says who opened a file, which file, and the chat it was in", async () => {
    renderLog([OPENED_DM]);
    await screen.findByText("image.png");

    const r = within(rowOf("image.png"));
    expect(r.getByText("Priya Sharma")).toBeInTheDocument();
    expect(r.getByText(/opened a file/)).toBeInTheDocument();
    expect(r.getByText("in Chat with Divya Bhamri")).toBeInTheDocument();
  });

  it("says which channel a download was from", async () => {
    renderLog([DOWNLOADED_CHANNEL]);
    await screen.findByText("Text Extraction CSV Data Report.pdf");

    const r = within(rowOf("Text Extraction CSV Data Report.pdf"));
    expect(r.getByText(/downloaded a file/)).toBeInTheDocument();
    expect(r.getByText("in #GRC Development")).toBeInTheDocument();
  });

  it("shows only the file name when no chat was recorded, never a placeholder", async () => {
    renderLog([entry("file.opened", { filename: "Report.pdf" })]);
    await screen.findByText("Report.pdf");

    const text = rowOf("Report.pdf").textContent ?? "";
    expect(text).not.toMatch(/\bin\b.*(Chat|#)/);
    expect(text).not.toMatch(/undefined|null|unknown/i);
  });

  it("ignores a chat kind it does not know instead of guessing", async () => {
    renderLog([entry("file.opened", { filename: "a.pdf", contextKind: "group", contextName: "Team" })]);
    await screen.findByText("a.pdf");

    expect(screen.queryByText(/Team/)).not.toBeInTheDocument();
  });

  it("draws nothing extra for a file entry with neither a name nor a chat", async () => {
    renderLog([entry("file.downloaded", null)]);
    const row = (await screen.findByText(/downloaded a file/)).closest("div.flex.items-start")!;

    // The metadata line holds the date and nothing else: no empty chip.
    expect(row.querySelector(".text-muted")!.children).toHaveLength(1);
  });

  it("leaves other audit entries exactly as they were", async () => {
    renderLog([entry("member.role_changed", { from: ["member"], to: "org_admin" }), OPENED_DM]);
    await screen.findByText("image.png");

    expect(screen.getByText("member → org_admin")).toBeInTheDocument();
    expect(screen.getAllByText(/changed a role/)).toHaveLength(1);
  });

  it("does not print the IP, device or ids on the row", async () => {
    renderLog([OPENED_DM]);
    await screen.findByText("image.png");

    const text = rowOf("image.png").textContent ?? "";
    expect(text).not.toContain("203.0.113.9");
    expect(text).not.toContain("cv-1");
  });
});
