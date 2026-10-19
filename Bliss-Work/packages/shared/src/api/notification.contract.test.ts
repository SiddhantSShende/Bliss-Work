/**
 * The notification list/count contract, checked against REAL responses captured from the
 * running service (see __fixtures__/notifications.live.json), not hand-written JSON.
 *
 * Two builds of notification-svc are in the fixture:
 *   current           this repo: `{items, nextCursor}`, honours `read=`, pages by cursor.
 *   deployed_4b12e80  what production ran on 2026-10-05: ignores `limit`/`cursor`/`read` and
 *                     answers a bare array, so BOTH panel requests got the same array.
 *
 * The client's schema is strict on purpose. The second case below is the production console
 * line "response validation failed /api/v1/notifications?limit=10&read=…", pinned: the answer
 * to it is deploying the service the client was written against, never loosening the schema.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";
import { NotificationPageDTO } from "../types/domain";
import { logger } from "../logging";
import fixtures from "./__fixtures__/notifications.live.json";

const client = () => new ApiClient({ notificationBase: "http://notif.test", getToken: async () => "t" } as never);
const serve = (body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })),
  );
afterEach(() => vi.unstubAllGlobals());

describe("current notification-svc responses satisfy the client schema", () => {
  const { unread, read, all, unreadCount } = fixtures.current;

  it("GET ?limit=10&read=false is schema-valid and holds only unread notifications", () => {
    const page = NotificationPageDTO.parse(unread);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((n) => n.read === false)).toBe(true);
  });

  it("GET ?limit=10&read=true is schema-valid and holds only read notifications, old ones included", () => {
    const page = NotificationPageDTO.parse(read);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((n) => n.read === true)).toBe(true);
    const oldest = Math.min(...page.items.map((n) => Date.parse(n.createdAt)));
    expect(Date.now() - oldest).toBeGreaterThan(30 * 86_400_000); // history, not just recent
  });

  it("with no read filter the history is exactly the two feeds together", () => {
    const ids = (p: unknown) => NotificationPageDTO.parse(p).items.map((n) => n.id).sort();
    expect(ids(all)).toEqual([...ids(unread), ...ids(read)].sort());
  });

  it("the bell's count equals the unread records the list returns", () => {
    expect(unreadCount.unreadCount).toBe(NotificationPageDTO.parse(unread).items.length);
  });

  it("is delivered through ApiClient.notificationPage without a validation error", async () => {
    serve(unread);
    const page = await client().notificationPage(undefined, 10, false);
    expect(page.items.map((n) => n.read)).toEqual(NotificationPageDTO.parse(unread).items.map(() => false));
  });
});

describe("the notification-svc build that predates paging fails the strict schema — by design", () => {
  const { unread, read } = fixtures.deployed_4b12e80;

  it("answers read=false and read=true with the same bare array, ignoring the filter", () => {
    expect(Array.isArray(unread) && Array.isArray(read)).toBe(true);
    expect(unread).toEqual(read);
    expect(read.some((n) => n.read === false)).toBe(true); // "read=true" returned unread rows
  });

  it.each([
    ["read=false", unread],
    ["read=true", read],
  ])("is rejected for ?limit=10&%s, loudly, instead of being treated as an empty list", async (_q, body) => {
    expect(NotificationPageDTO.safeParse(body).success).toBe(false);
    // The path and the raw zod issues are never logged (they can carry ids/PII
    // from the response) — only a redacted, structured issue count. See
    // packages/shared/src/logging.ts.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    serve(body);

    const err = await client().notificationPage(undefined, 10, false).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502 });
    expect(warn).toHaveBeenCalledWith("response validation failed", { issueCount: expect.any(Number) });
    warn.mockRestore();
  });
});

describe("createTask response", () => {
  const withTaskBase = (body: unknown) => {
    serve(body);
    return new ApiClient({ taskBase: "http://task.test", getToken: async () => "t" } as never).createTask({ taskTitle: "t", title: "t", description: "d" });
  };

  it("accepts the explicit scheduleId: null task-svc sends for an immediate task", async () => {
    await expect(withTaskBase({ taskId: "abc", scheduleId: null })).resolves.toMatchObject({ taskId: "abc" });
  });

  it("still accepts an absent scheduleId and a real one", async () => {
    await expect(withTaskBase({ taskId: "abc" })).resolves.toMatchObject({ taskId: "abc" });
    await expect(withTaskBase({ taskId: "abc", scheduleId: "s1" })).resolves.toMatchObject({ scheduleId: "s1" });
  });

  it("still rejects a response with no taskId", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(withTaskBase({ scheduleId: null })).rejects.toBeInstanceOf(ApiError);
  });
});
