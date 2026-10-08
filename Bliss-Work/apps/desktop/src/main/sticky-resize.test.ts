import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) } }));

import { RESIZE_EDGES, draggedBounds, isNoteDrag, resizedBounds, setNoteResizable, STICKY_MAX_SIZE, STICKY_MIN_SIZE } from "./sticky-resize";
import type { BrowserWindow } from "electron";

const start = { x: 500, y: 300, width: 380, height: 340 };

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

  it("never goes below the minimum, and the far edge stays fixed when it clamps", () => {
    const b = resizedBounds(start, "nw", 500, 500);

    expect(b.width).toBe(STICKY_MIN_SIZE.width);
    expect(b.height).toBe(STICKY_MIN_SIZE.height);
    expect(b.x + b.width).toBe(start.x + start.width);
    expect(b.y + b.height).toBe(start.y + start.height);
  });

  it("never goes above the maximum, and the far edge stays fixed when it clamps", () => {
    const b = resizedBounds(start, "nw", -500, -500);

    expect(b.width).toBe(STICKY_MAX_SIZE.width);
    expect(b.height).toBe(STICKY_MAX_SIZE.height);
    expect(b.x + b.width).toBe(start.x + start.width);
    expect(b.y + b.height).toBe(start.y + start.height);
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
