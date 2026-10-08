import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ made: [] as unknown[] }));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeNotification extends EventEmitter {
    static isSupported = () => true;
    constructor() {
      super();
      h.made.push(this);
    }
    show = vi.fn();
  }
  return { Notification: FakeNotification };
});

import { livePopupCount, raise } from "./notifier";

const popup = { notificationId: "n", title: "t", body: "b" };
const last = () => h.made[h.made.length - 1] as EventEmitter;

beforeEach(() => {
  // Drain anything a previous test left held.
  for (const n of h.made as EventEmitter[]) n.emit("close");
  h.made.length = 0;
});

describe("raise (OS popup retention)", () => {
  it("holds a popup after raise so it cannot be garbage-collected before the user clicks it", () => {
    raise(popup, () => {});
    expect(livePopupCount()).toBe(1);
  });

  it("still runs the click handler, then lets the popup go", () => {
    const onClick = vi.fn();
    raise(popup, onClick);
    last().emit("click");
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(livePopupCount()).toBe(0);
  });

  it.each(["close", "failed"])("releases the popup on %s", (event) => {
    raise(popup, () => {});
    raise(popup, () => {});
    last().emit(event);
    expect(livePopupCount()).toBe(1);
  });
});
