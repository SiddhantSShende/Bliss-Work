import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ workAreaSize: { width: 1920, height: 1080 } }));
vi.mock("electron", () => ({
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getPrimaryDisplay: () => ({ workAreaSize: h.workAreaSize }),
  },
}));

import {
  RESIZE_EDGES,
  draggedBounds,
  getStickyMaxSize,
  isNoteDrag,
  resizedBounds,
  setNoteResizable,
  STICKY_MIN_SIZE,
} from "./sticky-resize";
import type { BrowserWindow } from "electron";

const start = { x: 500, y: 300, width: 380, height: 340 };

afterEach(() => {
  h.workAreaSize = { width: 1920, height: 1080 };
});

describe("resizedBounds", () => {
  it("moves only the dragged edge, anchoring the opposite one", () => {
    expect(resizedBounds(start, "e", 20, 99)).toEqual({ x: 500, y: 300, width: 400, height: 340 });
    expect(resizedBounds(start, "s", 99, 20)).toEqual({ x: 500, y: 300, width: 380, height: 360 });
    expect(resizedBounds(start, "w", -20, 99)).toEqual({ x: 480, y: 300, width: 400, height: 340 });
    expect(resizedBounds(start, "n", 99, -20)).toEqual({ x: 500, y: 280, width: 380, height: 360 });
  });

  it("resizes both axes from a corner, anchoring the opposite corner", () => {
    expect(resizedBounds(start, "se", 10, 20)).toEqual({ x: 500, y: 300, width: 390, height: 360 });
    expect(resizedBounds(start, "nw", -10, -20)).toEqual({ x: 490, y: 280, width: 390, height: 360 });
    expect(resizedBounds(start, "ne", 10, -20)).toEqual({ x: 500, y: 280, width: 390, height: 360 });
    expect(resizedBounds(start, "sw", -10, 20)).toEqual({ x: 490, y: 300, width: 390, height: 360 });
  });

  it("shrinks to the compact minimum, and the far edge stays fixed when it clamps", () => {
    const b = resizedBounds(start, "nw", 500, 500);

    expect(b.width).toBe(STICKY_MIN_SIZE.width);
    expect(b.height).toBe(STICKY_MIN_SIZE.height);
    expect(b.x + b.width).toBe(start.x + start.width);
    expect(b.y + b.height).toBe(start.y + start.height);
  });

  it("sets the minimum below the former widget-sized threshold", () => {
    const b = resizedBounds(start, "se", -1_000, -1_000);

    expect(b.width).toBe(180);
    expect(b.height).toBe(160);
  });

  it("expands to the available workspace, and the far edge stays fixed when it clamps", () => {
    const b = resizedBounds(start, "nw", -2_000, -2_000);

    expect(b.width).toBe(1920);
    expect(b.height).toBe(1080);
    expect(b.x + b.width).toBe(start.x + start.width);
    expect(b.y + b.height).toBe(start.y + start.height);
  });

  it("uses updated workspace dimensions after display metrics change", () => {
    h.workAreaSize = { width: 1280, height: 720 };

    expect(getStickyMaxSize()).toEqual({ width: 1280, height: 720 });
    expect(resizedBounds(start, "se", 2_000, 2_000)).toEqual({
      x: start.x,
      y: start.y,
      width: 1280,
      height: 720,
    });

    h.workAreaSize = { width: 1920, height: 1080 };
  });

  it("is a no-op for a zero drag on every handle", () => {
    for (const edge of RESIZE_EDGES) expect(resizedBounds(start, edge, 0, 0)).toEqual(start);
  });
});

describe("draggedBounds", () => {
  it("moves the note without changing its size", () => {
    expect(draggedBounds(start, "move", -50, 40)).toEqual({ x: 450, y: 340, width: 380, height: 340 });
  });

  it("treats an edge drag as a resize", () => {
    expect(draggedBounds(start, "se", 10, 20)).toEqual(resizedBounds(start, "se", 10, 20));
  });
});

describe("isNoteDrag", () => {
  it("accepts the eight handles and 'move', nothing else", () => {
    for (const drag of [...RESIZE_EDGES, "move"]) expect(isNoteDrag(drag)).toBe(true);
    for (const bad of ["", "x", "NE", "n ", "Move", 1, null, undefined, {}]) expect(isNoteDrag(bad)).toBe(false);
  });
});

describe("setNoteResizable", () => {
  const realPlatform = process.platform;
  const on = (platform: NodeJS.Platform, resizable: boolean) => {
    Object.defineProperty(process, "platform", { value: platform });
    const setResizable = vi.fn();
    setNoteResizable({ setResizable } as unknown as BrowserWindow, resizable);
    Object.defineProperty(process, "platform", { value: realPlatform });
    return setResizable.mock.calls;
  };

  it("passes the request through on Windows and macOS", () => {
    expect(on("win32", true)).toEqual([[true]]);
    expect(on("darwin", false)).toEqual([[false]]);
  });

  it("never re-enables the native border on Linux", () => {
    expect(on("linux", true)).toEqual([[false]]);
    expect(on("linux", false)).toEqual([[false]]);
  });
});
