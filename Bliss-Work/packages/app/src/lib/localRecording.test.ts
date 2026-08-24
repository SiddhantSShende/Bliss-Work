import { describe, expect, it } from "vitest";
import type { Track } from "livekit-client";

import { extensionFor, recordingFilename, type RecordingTile } from "./localRecording";
import { tilesFrom } from "./useLocalRecording";
import type { RoomParticipant } from "./useCallRoom";

/** The single tile one participant produces. Throws rather than returning
 *  undefined so a mapping that drops someone fails the test it belongs to. */
const soloTile = (p: RoomParticipant): RecordingTile => {
  const [tile] = tilesFrom([p]);
  if (!tile) throw new Error("expected a tile");
  return tile;
};

/** A Track is only ever read for its underlying MediaStreamTrack here, which is
 *  what the compositor draws and mixes. */
const track = (id: string): Track => ({ mediaStreamTrack: { id } }) as unknown as Track;

const person = (over: Partial<RoomParticipant> = {}): RoomParticipant => ({
  identity: "alice",
  name: "Alice",
  isLocal: false,
  speaking: false,
  micOn: true,
  camOn: true,
  sharing: false,
  videoTrack: track("cam"),
  screenTrack: null,
  audioTrack: track("mic"),
  ...over,
});

describe("recordingFilename", () => {
  it("says which meeting it is, and sorts by day", () => {
    expect(recordingFilename("Weekly Sync!", "webm", new Date(2026, 7, 19))).toBe(
      "weekly-sync-recording-2026-08-19.webm",
    );
  });

  it("falls back to a usable name for an untitled meeting", () => {
    expect(recordingFilename("", "webm", new Date(2026, 7, 19))).toBe(
      "meeting-recording-2026-08-19.webm",
    );
  });

  it("carries the container the recorder actually produced", () => {
    expect(recordingFilename("Standup", "mp4", new Date(2026, 7, 19))).toBe(
      "standup-recording-2026-08-19.mp4",
    );
  });
});

describe("extensionFor", () => {
  it("matches the container the encoder chose", () => {
    expect(extensionFor("video/webm;codecs=vp8,opus")).toBe("webm");
    expect(extensionFor("video/mp4")).toBe("mp4");
  });
});

describe("tilesFrom", () => {
  it("draws the camera, and mixes the microphone", () => {
    const tile = soloTile(person());
    expect(tile.name).toBe("Alice");
    expect(tile.video?.id).toBe("cam");
    expect(tile.audio?.id).toBe("mic");
    expect(tile.letterbox).toBe(false);
  });

  it("lets a shared screen win the tile, letterboxed", () => {
    // The rule CallTile applies on screen: a screen share is what the room is
    // looking at, and cropping it cuts off what it was shared for.
    const tile = soloTile(
      person({ sharing: true, screenTrack: track("screen"), videoTrack: track("cam") }),
    );
    expect(tile.video?.id).toBe("screen");
    expect(tile.letterbox).toBe(true);
  });

  it("draws no picture for a camera that is off", () => {
    const tile = soloTile(person({ camOn: false }));
    expect(tile.video).toBeNull();
    // Still mixed in: someone with their camera off is still talking.
    expect(tile.audio?.id).toBe("mic");
  });

  it("still shows a shared screen when the camera is off", () => {
    const tile = soloTile(person({ camOn: false, sharing: true, screenTrack: track("screen") }));
    expect(tile.video?.id).toBe("screen");
  });

  it("keeps everyone, so the grid is the meeting rather than the speakers", () => {
    const tiles = tilesFrom([
      person({ identity: "a", name: "Alice" }),
      person({ identity: "b", name: "Bob", camOn: false, audioTrack: null }),
    ]);
    expect(tiles.map((t) => t.name)).toEqual(["Alice", "Bob"]);
    expect(tiles.map((t) => t.audio?.id ?? null)).toEqual(["mic", null]);
  });
});
