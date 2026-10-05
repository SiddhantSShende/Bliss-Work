/**
 * The click every surface shares: mark read, then go where the notification leads.
 * Nowhere to go means mark read only — never a navigation.
 */
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { openNotification, openNotificationAt } from "./openNotification";

const TASK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHANNEL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MESSAGE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function setup(currentPath = "/app/mail") {
  const order: string[] = [];
  const markNotificationRead = vi.fn(async (id: string) => void order.push(`read:${id}`));
  const navigate = vi.fn((to: string) => void order.push(`go:${to}`));
  const deps = { qc: new QueryClient(), api: { markNotificationRead }, navigate, currentPath: () => currentPath };
  return { deps, markNotificationRead, navigate, order };
}

describe("openNotification", () => {
  it("marks a task notification read and opens that task", () => {
    const { deps, markNotificationRead, navigate } = setup();
    openNotification(deps, { id: "n1", kind: "TASK_ASSIGNED", taskId: TASK });
    expect(markNotificationRead).toHaveBeenCalledWith("n1");
    expect(navigate).toHaveBeenCalledWith(`/app/mail/task/${TASK}`, { replace: false });
  });

  it("marks read before it navigates", () => {
    const { deps, order } = setup();
    openNotification(deps, { id: "n1", kind: "TASK_ASSIGNED", taskId: TASK });
    expect(order[0]).toBe("read:n1");
    expect(order[1]).toBe(`go:/app/mail/task/${TASK}`);
  });

  it("opens a channel message at the message", () => {
    const { deps, navigate } = setup();
    openNotification(deps, { id: "n2", kind: "CHANNEL_MESSAGE", channelId: CHANNEL, messageId: MESSAGE });
    expect(navigate).toHaveBeenCalledWith(`/app/channels/${CHANNEL}?m=${MESSAGE}`, { replace: false });
  });

  it("only marks read when the notification leads nowhere", () => {
    const { deps, markNotificationRead, navigate } = setup();
    openNotification(deps, { id: "n3", kind: "SOMETHING_NEW" });
    expect(markNotificationRead).toHaveBeenCalledWith("n3");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("still navigates when marking it read fails", async () => {
    const { deps, navigate } = setup();
    deps.api.markNotificationRead.mockRejectedValueOnce(new Error("offline"));
    openNotification(deps, { id: "n4", kind: "TASK_ASSIGNED", taskId: TASK });
    await Promise.resolve();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("reads where the user is at click time", () => {
    const { deps, navigate } = setup(`/app/channels/${CHANNEL}`);
    openNotification(deps, { id: "n5", kind: "CHANNEL_MESSAGE", channelId: CHANNEL, messageId: MESSAGE });
    expect(navigate).toHaveBeenCalledWith(`/app/channels/${CHANNEL}?m=${MESSAGE}`, { replace: true });
  });
});

describe("openNotificationAt", () => {
  it("takes a route that was already resolved (the desktop popup's)", () => {
    const { deps, markNotificationRead, navigate } = setup();
    openNotificationAt(deps, "n6", `/app/channels/${CHANNEL}`);
    expect(markNotificationRead).toHaveBeenCalledWith("n6");
    expect(navigate).toHaveBeenCalledWith(`/app/channels/${CHANNEL}`, { replace: false });
    navigate.mockClear();
    openNotificationAt(deps, "n7", null);
    expect(navigate).not.toHaveBeenCalled();
  });
});
