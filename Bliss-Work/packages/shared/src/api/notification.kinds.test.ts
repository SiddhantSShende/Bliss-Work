/**
 * The notification feed is the user's WHOLE history — tasks, chat, channels, meetings and
 * whatever a newer server adds — in one list. These tests pin that on real data:
 *
 *  - __fixtures__/notifications.allkinds.live.json is a real GET /api/v1/notifications body,
 *    produced by real task-svc / messaging-svc API calls and persisted by the current
 *    notification-svc (not hand-written), and must satisfy the strict page schema.
 *  - The client's list of known kinds must equal the kinds notification-svc can write, read
 *    straight from its source, so a kind added on the server can't go unrendered unnoticed.
 *  - A kind the client has never heard of must travel through the page schema and the live
 *    event schema with its data intact — it must not fail the page that holds everything else.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { NOTIFICATION_KINDS, NotificationPageDTO } from "../types/domain";
import { ServerEvent } from "../types/events";
import live from "./__fixtures__/notifications.allkinds.live.json";

const serve = (body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })),
  );
const client = () => new ApiClient({ notificationBase: "http://notif.test", getToken: async () => "t" } as never);
afterEach(() => vi.unstubAllGlobals());

describe("the real all-kinds feed", () => {
  it("is schema-valid and carries every user-facing category in one list", () => {
    const page = NotificationPageDTO.parse(live);
    const kinds = new Set(page.items.map((n) => n.kind));
    for (const k of ["TASK_ASSIGNED", "DM_MESSAGE", "CHANNEL_MESSAGE", "CHANNEL_ADDED", "MEETING_SCHEDULED", "MEETING_INVITATION"]) {
      expect(kinds, k).toContain(k);
    }
  });

  it("is served newest first, and each row carries the id its destination needs", () => {
    const page = NotificationPageDTO.parse(live);
    const times = page.items.map((n) => Date.parse(n.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const by = Object.fromEntries(page.items.map((n) => [n.kind, n]));
    expect(by.TASK_ASSIGNED?.taskId).toBeTruthy();
    expect(by.DM_MESSAGE?.conversationId).toBeTruthy();
    expect(by.CHANNEL_MESSAGE?.channelId).toBeTruthy();
    expect(by.CHANNEL_ADDED?.channelId).toBeTruthy();
    expect(by.MEETING_SCHEDULED?.callId).toBeTruthy();
    expect(by.MEETING_INVITATION?.callId).toBeTruthy();
  });
});

describe("known kinds mirror notification-svc", () => {
  it("NOTIFICATION_KINDS equals the Kind… constants in notification-svc/internal/events/events.go", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../../../services/notification-svc/internal/events/events.go", import.meta.url)),
      "utf8",
    );
    const server = [...src.matchAll(/^\s*Kind\w+\s*=\s*"([A-Z_]+)"/gm)].map((m) => m[1]);
    expect(server.length).toBeGreaterThanOrEqual(12);
    expect([...NOTIFICATION_KINDS].sort()).toEqual([...server].sort());
  });
});

describe("a kind this build does not know", () => {
  const future = { ...live.items[0]!, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "CALL_MISSED", text: "Missed call from Priya" };

  it("does not fail the page: the other rows load and the unknown one keeps its data", () => {
    const page = NotificationPageDTO.parse({ items: [future, ...live.items], nextCursor: null });
    expect(page.items).toHaveLength(live.items.length + 1);
    expect(page.items[0]).toMatchObject({ kind: "CALL_MISSED", text: "Missed call from Priya", read: false });
  });

  it("comes through ApiClient.notificationPage as a normal row", async () => {
    serve({ items: [future, ...live.items], nextCursor: null });
    const page = await client().notificationPage(undefined, 10);
    expect(page.items.map((n) => n.kind)).toContain("CALL_MISSED");
    expect(page.items).toHaveLength(live.items.length + 1);
  });

  it("still rejects a record with no kind at all", () => {
    expect(NotificationPageDTO.safeParse({ items: [{ ...future, kind: "" }], nextCursor: null }).success).toBe(false);
  });

  it("is accepted by the live notification.created frame instead of the frame being dropped", () => {
    const frame = {
      type: "notification.created",
      eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      orgId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      occurredAt: "2026-10-05T12:00:00.000Z",
      notificationId: future.id,
      recipientId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      kind: "CALL_MISSED",
      text: future.text,
    };
    const parsed = ServerEvent.safeParse(frame);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.type === "notification.created" && parsed.data.kind).toBe("CALL_MISSED");
  });
});
