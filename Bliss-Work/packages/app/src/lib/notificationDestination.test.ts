import { describe, expect, it, vi } from "vitest";
import { NOTIFICATION_KINDS } from "@taskboard/shared";
import { isNotificationRoute, notificationCategory, notificationDestination, notificationRoute, openNotificationRoute } from "./notificationDestination";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("notificationDestination", () => {
  it.each([
    [{ kind: "CHANNEL_ADDED", channelId: A }, `/app/channels/${A}`],
    [{ kind: "CHANNEL_CREATED", channelId: A }, `/app/channels/${A}`],
    [{ kind: "CHANNEL_MESSAGE", channelId: A }, `/app/channels/${A}`],
    [{ kind: "DM_MESSAGE", conversationId: A }, `/app/chats/${A}`],
    [{ kind: "MEETING_INVITATION", callId: A }, `/app/meetings/${A}`],
    [{ kind: "MEETING_UPDATED", callId: A }, `/app/meetings/${A}`],
    [{ kind: "MEETING_STARTED", callId: A }, `/app/meetings/${A}`],
    [{ kind: "TASK_ASSIGNED", taskId: A }, `/app/mail/task/${A}`],
  ] as const)("%j leads to its own record", (n, path) => {
    expect(notificationDestination(n)).toBe(path);
  });

  it.each([
    [{ kind: "CHANNEL_ADDED", channelId: null }, "/app/channels"],
    [{ kind: "DM_MESSAGE" }, "/app/chats"],
    [{ kind: "MEETING_SCHEDULED", callId: null }, "/app/meetings"],
    [{ kind: "MEETING_UPDATED", callId: null }, "/app/meetings"],
    [{ kind: "MEETING_STARTED", callId: null }, "/app/meetings"],
    [{ kind: "TASK_LEFT", taskId: null }, "/app/tasks/allocated"],
  ] as const)("%j falls back to its section", (n, path) => {
    expect(notificationDestination(n)).toBe(path);
  });

  it("sends a cancelled meeting to the meetings list, even when the record still carries its id", () => {
    // The meeting's rows are deleted by the cancel: its id opens nothing.
    expect(notificationDestination({ kind: "MEETING_CANCELLED", callId: A })).toBe("/app/meetings");
    expect(notificationDestination({ kind: "MEETING_CANCELLED", callId: null })).toBe("/app/meetings");
  });

  it("does not trust an id that is not a UUID", () => {
    for (const bad of ["../../settings", "x/../y", "javascript:alert(1)", `${A}/extra`, "", "123"]) {
      expect(notificationDestination({ kind: "CHANNEL_ADDED", channelId: bad })).toBe("/app/channels");
    }
  });

  it("sends a kind this build does not know to the app home, not to a made-up path", () => {
    expect(notificationDestination({ kind: "SOMETHING_NEW" as never, channelId: A })).toBe("/app");
  });
});

describe("isNotificationRoute", () => {
  it("accepts exactly what notificationDestination can produce", () => {
    for (const path of [
      "/app", "/app/channels", "/app/chats", "/app/meetings", "/app/tasks/allocated",
      `/app/channels/${A}`, `/app/chats/${A}`, `/app/meetings/${A}`, `/app/mail/task/${A}`,
    ]) {
      expect(isNotificationRoute(path)).toBe(true);
    }
  });

  it("refuses anything else", () => {
    for (const path of [
      "", "/", "/login", "//evil.example", "https://evil.example", "/app/settings", "/app/org",
      "/app/channels/not-a-uuid", `/app/channels/${A}/extra`, `/app/channels/${A}?x=1`, `/app/channels/${A}#x`,
      "/app/../login", "app/channels", null, undefined, 42,
    ]) {
      expect(isNotificationRoute(path)).toBe(false);
    }
  });
});

describe("openNotificationRoute", () => {
  it("pushes when the target is somewhere else", () => {
    const navigate = vi.fn();
    openNotificationRoute(navigate, "/app/settings", `/app/channels/${A}`);
    expect(navigate).toHaveBeenCalledWith(`/app/channels/${A}`, { replace: false });
  });

  it("replaces when the target is already open", () => {
    const navigate = vi.fn();
    openNotificationRoute(navigate, `/app/channels/${A}`, `/app/channels/${A}`);
    expect(navigate).toHaveBeenCalledWith(`/app/channels/${A}`, { replace: true });
  });
});

describe("notificationCategory", () => {
  it.each([
    ["TASK_ASSIGNED", "task"],
    ["TASK_ACKNOWLEDGED", "task"],
    ["TASK_COMPLETED", "task"],
    ["TASK_IGNORED", "task"],
    ["TASK_LEFT", "task"],
    ["TASK_WITHDRAWN", "task"],
    ["DM_MESSAGE", "chat"],
    ["CHANNEL_MESSAGE", "chat"], // a message in a channel is chat, not a channel event
    ["CHANNEL_ADDED", "channel"],
    ["CHANNEL_CREATED", "channel"],
    ["MEETING_SCHEDULED", "meeting"],
    ["MEETING_INVITATION", "meeting"],
    ["MEETING_UPDATED", "meeting"],
    ["MEETING_STARTED", "meeting"],
    ["MEETING_CANCELLED", "meeting"],
  ] as const)("%s is a %s notification", (kind, category) => {
    expect(notificationCategory(kind)).toBe(category);
  });

  it("gives every kind notification-svc produces a real category — none falls through to 'other'", () => {
    for (const kind of NOTIFICATION_KINDS) expect(notificationCategory(kind), kind).not.toBe("other");
  });

  it("puts a sibling a newer server adds into its family, and anything else in 'other'", () => {
    expect(notificationCategory("TASK_REOPENED")).toBe("task");
    expect(notificationCategory("CALL_MISSED")).toBe("meeting");
    expect(notificationCategory("MEETING_CANCELLED")).toBe("meeting");
    expect(notificationCategory("BILLING_ALERT")).toBe("other");
  });
});

describe("a kind this build does not know", () => {
  it("opens the app's home — never a made-up path — even when it carries ids", () => {
    expect(notificationDestination({ kind: "BILLING_ALERT", taskId: A, channelId: A, conversationId: A, callId: A })).toBe("/app");
  });
});

describe("landing on a message", () => {
  const M = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("puts the message id on the channel and chat routes only", () => {
    expect(notificationDestination({ kind: "CHANNEL_MESSAGE", channelId: A, messageId: M })).toBe(`/app/channels/${A}?m=${M}`);
    expect(notificationDestination({ kind: "DM_MESSAGE", conversationId: A, messageId: M })).toBe(`/app/chats/${A}?m=${M}`);
    expect(notificationDestination({ kind: "CHANNEL_CREATED", channelId: A, messageId: M })).toBe(`/app/channels/${A}`);
    expect(notificationDestination({ kind: "TASK_ASSIGNED", taskId: A, messageId: M })).toBe(`/app/mail/task/${A}`);
  });

  it("opens the thread without a message when the id is missing or not a UUID", () => {
    for (const messageId of [null, undefined, "", "x", `${M}&x=1`, "../x"]) {
      expect(notificationDestination({ kind: "CHANNEL_MESSAGE", channelId: A, messageId })).toBe(`/app/channels/${A}`);
    }
  });

  it("drops the message id when there is no thread to put it in", () => {
    expect(notificationDestination({ kind: "CHANNEL_MESSAGE", channelId: null, messageId: M })).toBe("/app/channels");
    expect(notificationDestination({ kind: "DM_MESSAGE", messageId: M })).toBe("/app/chats");
  });

  it("accepts exactly those routes", () => {
    expect(isNotificationRoute(`/app/channels/${A}?m=${M}`)).toBe(true);
    expect(isNotificationRoute(`/app/chats/${A}?m=${M}`)).toBe(true);
    for (const bad of [`/app/channels/${A}?m=x`, `/app/channels/${A}?m=${M}&x=1`, `/app/channels/${A}?x=${M}`, `/app/meetings/${A}?m=${M}`, `/app/channels?m=${M}`]) {
      expect(isNotificationRoute(bad), bad).toBe(false);
    }
  });

  it("replaces rather than stacks when the thread is already open", () => {
    const navigate = vi.fn();
    openNotificationRoute(navigate, `/app/channels/${A}`, `/app/channels/${A}?m=${M}`);
    expect(navigate).toHaveBeenCalledWith(`/app/channels/${A}?m=${M}`, { replace: true });
    openNotificationRoute(navigate, "/app/mail", `/app/channels/${A}?m=${M}`);
    expect(navigate).toHaveBeenLastCalledWith(`/app/channels/${A}?m=${M}`, { replace: false });
  });
});

describe("notificationRoute", () => {
  it("is the destination, or null when the notification leads nowhere", () => {
    expect(notificationRoute({ kind: "TASK_ASSIGNED", taskId: A })).toBe(`/app/mail/task/${A}`);
    expect(notificationRoute({ kind: "A_KIND_FROM_THE_FUTURE" })).toBeNull();
  });
});
