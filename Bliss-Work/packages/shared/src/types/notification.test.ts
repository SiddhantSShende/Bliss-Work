import { describe, expect, it } from "vitest";
import { NotificationCreated } from "./events";
import { NotificationDTO, NotificationPageDTO } from "./domain";

const id = "018f0000-0000-7000-8000-0000000000a1";

describe("notification wire contracts", () => {
  it("accepts every persisted kind in notification.created events", () => {
    const kinds = [
      "TASK_ASSIGNED",
      "TASK_ACKNOWLEDGED",
      "TASK_COMPLETED",
      "TASK_IGNORED",
      "TASK_LEFT",
      "TASK_WITHDRAWN",
      "CHANNEL_ADDED",
      "CHANNEL_CREATED",
      "DM_MESSAGE",
      "CHANNEL_MESSAGE",
      "MEETING_SCHEDULED",
      "MEETING_INVITATION",
    ] as const;

    for (const kind of kinds) {
      expect(NotificationCreated.safeParse({
        type: "notification.created",
        eventId: id,
        orgId: id,
        occurredAt: "2026-09-30T10:00:00.000Z",
        notificationId: id,
        recipientId: id,
        kind,
        text: "Notification text",
        callId: kind.startsWith("MEETING_") ? id : undefined,
      }).success).toBe(true);
    }
  });

  it("parses stable call destinations and cursor-paged notification responses", () => {
    const item = NotificationDTO.parse({
      id,
      kind: "MEETING_INVITATION",
      text: "Meeting invitation: Planning",
      taskId: null,
      callId: id,
      read: false,
      createdAt: "2026-09-30T10:00:00.000Z",
    });
    expect(NotificationPageDTO.parse({ items: [item], nextCursor: "cursor" })).toEqual({
      items: [item],
      nextCursor: "cursor",
    });
  });
});