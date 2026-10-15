/**
 * The member grid gives every tile a size of its own, decided by the area and
 * the head-count — never by what is inside the tile.
 *
 * jsdom has no layout engine, so the area is faked by giving elements a
 * clientWidth/clientHeight. That is enough to prove the contract that matters
 * here: a tile is handed explicit pixels (so a camera-off tile cannot collapse
 * to the height of its avatar, nor a portrait camera stretch its tile), and the
 * grid holds fewer people per page when the area is small.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RoomParticipant } from "../lib/useCallRoom";
import { fitTiles } from "../lib/tileLayout";
import { CallMembers } from "./CallMembers";

function person(identity: string, over: Partial<RoomParticipant> = {}): RoomParticipant {
  return {
    identity,
    name: identity.toUpperCase(),
    isLocal: false,
    speaking: false,
    micOn: true,
    camOn: false,
    sharing: false,
    videoTrack: null,
    screenTrack: null,
    audioTrack: null,
    ...over,
  };
}

const room = (n: number) => Array.from({ length: n }, (_, i) => person(`p${i}`));

let area = { width: 1312, height: 800 };
const proto = HTMLElement.prototype;
const original = {
  w: Object.getOwnPropertyDescriptor(proto, "clientWidth"),
  h: Object.getOwnPropertyDescriptor(proto, "clientHeight"),
};

beforeEach(() => {
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => area.width });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => area.height });
});

afterEach(() => {
  area = { width: 1312, height: 800 };
  if (original.w) Object.defineProperty(proto, "clientWidth", original.w);
  if (original.h) Object.defineProperty(proto, "clientHeight", original.h);
});

const renderGrid = (participants: RoomParticipant[]) =>
  render(<CallMembers participants={participants} hands={new Set()} pinned={null} onTogglePin={() => {}} />);

/** The sized box each tile sits in — the element carrying the explicit width/height. */
const slots = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("div[style*='width']"));

describe("CallMembers tile sizing", () => {
  it("hands every camera-off tile the size the layout computed, not the height of its avatar", () => {
    const { container } = renderGrid(room(2));
    const expected = fitTiles(2, area, 8)!;

    const boxes = slots(container);
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect(box.style.width).toBe(`${expected.width}px`);
      expect(box.style.height).toBe(`${expected.height}px`);
    }
    // The regression: a 96px strip with the avatar at the top.
    expect(expected.height).toBeGreaterThan(300);
  });

  it("gives every tile the same size, whatever mix of cameras is in the room", () => {
    const cams = [
      person("a", { camOn: true }),
      person("b"),
      person("c", { camOn: true, isLocal: true }),
      person("d"),
    ];
    const boxes = slots(renderGrid(cams).container);
    const sizes = new Set(boxes.map((b) => `${b.style.width}x${b.style.height}`));
    expect(boxes).toHaveLength(4);
    expect(sizes.size).toBe(1);
  });

  it("fills the whole area with one person, at no fixed size", () => {
    const { container } = renderGrid(room(1));
    expect(slots(container)).toHaveLength(0);
    expect(container.querySelectorAll(".absolute.inset-0")).not.toHaveLength(0);
    // the one tile is really there (avatar + name label), just not sized by the layout
    expect(container.querySelector(".rounded-full.from-brand-from")).not.toBeNull();
  });

  it("draws nothing until the area has a size, rather than tiles of the wrong one", () => {
    area = { width: 0, height: 0 };
    const { container } = renderGrid(room(4));
    expect(slots(container)).toHaveLength(0);
  });

  it("holds fewer people per page in a small area", () => {
    area = { width: 350, height: 480 };
    const { container } = renderGrid(room(12));
    const shown = slots(container).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(12);
    // and there is a way to the rest
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });

  it("puts a full page of twelve on a large area", () => {
    expect(slots(renderGrid(room(12)).container)).toHaveLength(12);
  });
});
