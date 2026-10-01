import { describe, expect, it, vi } from "vitest";
import { isNotificationRoute, notificationDestination, openNotificationRoute } from "./notificationDestination";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("notificationDestination", () => {
  it.each([
    [{ kind: "CHANNEL_ADDED", channelId: A }, `/app/channels/${A}`],
    [{ kind: "CHANNEL_CREATED", channelId: A }, `/app/channels/${A}`],
    [{ kind: "CHANNEL_MESSAGE", channelId: A }, `/app/channels/${A}`],
    [{ kind: "DM_MESSAGE", conversationId: A }, `/app/chats/${A}`],
    [{ kind: "MEETING_INVITATION", callId: A }, `/app/meetings/${A}`],
    [{ kind: "TASK_ASSIGNED", taskId: A }, `/app/mail/task/${A}`],
  ] as const)("%j leads to its own record", (n, path) => {
    expect(notificationDestination(n)).toBe(path);
  });

  it.each([
    [{ kind: "CHANNEL_ADDED", channelId: null }, "/app/channels"],
    [{ kind: "DM_MESSAGE" }, "/app/chats"],
    [{ kind: "MEETING_SCHEDULED", callId: null }, "/app/meetings"],
    [{ kind: "TASK_LEFT", taskId: null }, "/app/tasks/allocated"],
  ] as const)("%j falls back to its section", (n, path) => {
    expect(notificationDestination(n)).toBe(path);
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
