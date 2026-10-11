/**
 * The sticky overlay's Chat button has no router of its own — main must focus
 * the main window and forward the taskId to it. Mirrors
 * notification-open.test.ts's fake-window harness.
 */
import { describe, expect, it, vi } from "vitest";
import { openTaskChat, TASK_CHAT_OPEN_CHANNEL, type TaskChatWindow } from "./task-chat-open";

type FakeWindow = TaskChatWindow & {
  destroyed: boolean;
  loading: boolean;
  sent: unknown[];
  onLoaded: (() => void) | null;
};

function makeWindow(): FakeWindow {
  const win: FakeWindow = {
    destroyed: false,
    loading: false,
    sent: [],
    onLoaded: null,
    isDestroyed() {
      return win.destroyed;
    },
    webContents: {
      isLoading: () => win.loading,
      once: (_event, cb) => {
        win.onLoaded = cb;
      },
      send: (_channel, ...args) => win.sent.push(args[0]),
    },
  };
  return win;
}

describe("openTaskChat", () => {
  it("focuses first, then sends the taskId once the window is ready", () => {
    const win = makeWindow();
    const focus = vi.fn();
    openTaskChat({ taskId: "t1" }, focus, () => win);

    expect(focus).toHaveBeenCalledTimes(1);
    expect(win.sent).toEqual([{ taskId: "t1" }]);
  });

  it("waits for did-finish-load on a still-loading window, not before", () => {
    const win = makeWindow();
    win.loading = true;
    openTaskChat({ taskId: "t1" }, vi.fn(), () => win);

    expect(win.sent).toEqual([]);
    win.onLoaded?.();
    expect(win.sent).toEqual([{ taskId: "t1" }]);
  });

  it("does nothing if focus leaves no window", () => {
    const focus = vi.fn();
    expect(() => openTaskChat({ taskId: "t1" }, focus, () => null)).not.toThrow();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("does not send to a window destroyed while loading", () => {
    const win = makeWindow();
    win.loading = true;
    openTaskChat({ taskId: "t1" }, vi.fn(), () => win);
    win.destroyed = true;
    win.onLoaded?.();

    expect(win.sent).toEqual([]);
  });

  it("uses its own channel, distinct from the notification route channel", () => {
    expect(TASK_CHAT_OPEN_CHANNEL).toBe("task:open-chat");
  });
});
