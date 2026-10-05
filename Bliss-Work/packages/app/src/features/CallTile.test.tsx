/**
 * How a tile shows its participant — and, above all, that the picture never
 * decides the tile's size or crops itself.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { Track } from "livekit-client";
import type { RoomParticipant } from "../lib/useCallRoom";
import { CallTile } from "./CallTile";

const track = () =>
  ({ attach: vi.fn(), detach: vi.fn(), mediaStreamTrack: { id: "t" } }) as unknown as Track;

function person(over: Partial<RoomParticipant> = {}): RoomParticipant {
  return {
    identity: "a",
    name: "Piyush",
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

describe("CallTile", () => {
  it("lays the camera out of flow and never crops it", () => {
    const { container } = render(<CallTile p={person({ camOn: true, videoTrack: track() })} />);
    const video = container.querySelector("video")!;

    // Out of flow: the camera's intrinsic aspect ratio cannot size the tile.
    expect(video.className).toMatch(/\babsolute\b/);
    expect(video.className).toMatch(/\binset-0\b/);
    // Whole frame, always. cover would discard part of it and enlarge the face.
    expect(video.className).toMatch(/\bobject-contain\b/);
    expect(video.className).not.toMatch(/object-cover/);
  });

  it("does the same for a shared screen", () => {
    const { container } = render(<CallTile p={person({ sharing: true, screenTrack: track() })} />);
    const video = container.querySelector("video")!;
    expect(video.className).toMatch(/\bobject-contain\b/);
    expect(video.className).not.toMatch(/object-cover/);
  });

  it("centres the avatar in a tile with the camera off, independently of its content", () => {
    const { container } = render(<CallTile p={person()} />);
    expect(container.querySelector("video")).toBeNull();

    const avatar = container.querySelector(".rounded-full")!;
    expect(avatar.textContent).toBe("PI");
    // The avatar's layer covers the whole tile and centres on both axes, so it
    // does not depend on the tile having any height of its own.
    const layer = avatar.parentElement!;
    expect(layer.className).toMatch(/\babsolute\b/);
    expect(layer.className).toMatch(/\binset-0\b/);
    expect(layer.className).toMatch(/\bitems-center\b/);
    expect(layer.className).toMatch(/\bjustify-center\b/);
  });

  it("is a size container, so nothing inside can size it", () => {
    const { container } = render(<CallTile p={person()} />);
    expect((container.firstElementChild as HTMLElement).className).toContain("[container-type:size]");
  });

  it("does not mirror a remote participant's camera, only the local one", () => {
    const remote = render(<CallTile p={person({ camOn: true, videoTrack: track() })} />);
    expect(remote.container.querySelector("video")!.className).not.toContain("-scale-x-100");
    const local = render(<CallTile p={person({ isLocal: true, camOn: true, videoTrack: track() })} />);
    expect(local.container.querySelector("video")!.className).toContain("-scale-x-100");
  });
});
