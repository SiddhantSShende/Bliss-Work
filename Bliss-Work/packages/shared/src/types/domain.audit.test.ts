import { describe, expect, it } from "vitest";
import { AuditEntryDTO, AuditPage } from "./domain";

// Regression coverage: migrations/0018_audit_log_uuid_id.sql converted
// audit_log.id from a bigserial to a UUIDv7, and auth-svc's AuditEntryDTO /
// AuditPage schemas (services/auth-svc/app/schemas.py) followed suit — but
// this shared zod schema kept `id`/`nextCursor` typed as `z.number().int()`.
// Every real response therefore failed `AuditPage.safeParse(...)`, which
// ApiClient.req() turns into a 502 ApiError — the audit log was completely
// broken. These pin the CURRENT (string/UUID) contract so a future drift is
// caught here instead of in production.
describe("AuditEntryDTO", () => {
  it("parses a UUIDv7-shaped entry (current server contract)", () => {
    const parsed = AuditEntryDTO.parse({
      id: "018f2f6c-8b1a-7c3e-9c2a-1234567890ab",
      actorId: "018f2f6c-0000-7000-8000-000000000001",
      action: "member.role_changed",
      target: "018f2f6c-0000-7000-8000-000000000002",
      meta: { from: "member", to: "org_admin" },
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.id).toBe("018f2f6c-8b1a-7c3e-9c2a-1234567890ab");
    expect(typeof parsed.id).toBe("string");
  });

  it("does NOT reject a bare numeric-looking id string either — id is just a string", () => {
    // Guard against a regression back to z.number().int(), which would also
    // reject this legitimate case in the other direction.
    expect(() => AuditEntryDTO.parse({
      id: "1",
      actorId: null,
      action: "org.created",
      target: null,
      meta: null,
      at: "2026-01-01T00:00:00.000Z",
    })).not.toThrow();
  });
});

describe("AuditPage", () => {
  it("parses a real UUIDv7 page response end to end, including a string nextCursor", () => {
    const parsed = AuditPage.parse({
      entries: [
        {
          id: "018f2f6c-8b1a-7c3e-9c2a-1234567890ab",
          actorId: "018f2f6c-0000-7000-8000-000000000001",
          action: "member.deactivated",
          target: "018f2f6c-0000-7000-8000-000000000002",
          meta: null,
          at: "2026-01-01T00:00:00.000Z",
        },
      ],
      nextCursor: "018f2f6c-8b1a-7c3e-9c2a-000000000000",
    });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.nextCursor).toBe("018f2f6c-8b1a-7c3e-9c2a-000000000000");
  });

  it("parses the last page, where nextCursor is null", () => {
    const parsed = AuditPage.parse({ entries: [], nextCursor: null });
    expect(parsed.nextCursor).toBeNull();
  });

  it("would have REJECTED this exact response under the old z.number().int() schema", () => {
    // Documents the bug directly: a real server response is a string id, which
    // is not a valid `z.number().int()`. safeParse must succeed now.
    const serverResponse = {
      entries: [
        {
          id: "018f2f6c-8b1a-7c3e-9c2a-1234567890ab",
          actorId: null,
          action: "org.created",
          target: null,
          meta: null,
          at: "2026-01-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    };
    const result = AuditPage.safeParse(serverResponse);
    expect(result.success).toBe(true);
  });
});
