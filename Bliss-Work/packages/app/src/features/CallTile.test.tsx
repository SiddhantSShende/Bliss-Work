/**
 * Attaching media to a tile.
 *
 * The bug this exists for, reported from a real meeting: turn your camera off
 * and back on, and the tile stays BLANK — for the person who did it and for
 * anyone watching them.
 *
 * The cause is a React one rather than a WebRTC one. The <video> element is
 * conditionally rendered on `camOn || sharing`, so turning the camera off
 * UNMOUNTS it and turning it back on mounts a NEW element. Neither changes the
 * Track object's identity, so an effect keyed on the track alone never re-ran,
 * and the fresh element was never attached to anything.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { Track } from "livekit-client";
import { CallTile } from "./CallTile";
import type { RoomParticipant } from "../lib/useCallRoom";

/** A Track that records attach/detach, with a swappable underlying stream. */
function fakeTrack(streamId = "stream-1") {
  const t = {
    attach: vi.fn(),
    detach: vi.fn(),
    mediaStreamTrack: { id: streamId },
  };
  return t as unknown as Track & { attach: ReturnType<typeof vi.fn> };
}

function participant(over: Partial<RoomParticipant> = {}): RoomParticipant {
  return {
    identity: "u1",
    name: "Ada",
    isLocal: false,
    speaking: false,
    micOn: true,
    camOn: true,
    sharing: false,
    videoTrack: null,
    screenTrack: null,
    audioTrack: null,
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("CallTile video attach", () => {
  it("attaches the camera track when the tile first renders", () => {
    const track = fakeTrack();
    render(<CallTile p={participant({ videoTrack: track })} />);
    expect(track.attach).toHaveBeenCalledTimes(1);
  });

  it("RE-ATTACHES after the camera is turned off and on again", () => {
    // The regression. The track object is deliberately the SAME across all three
    // renders — that is exactly the case the old effect could not see.
    const track = fakeTrack();
    const { rerender } = render(<CallTile p={participant({ videoTrack: track })} />);
    expect(track.attach).toHaveBeenCalledTimes(1);

    rerender(<CallTile p={participant({ videoTrack: track, camOn: false })} />);
    rerender(<CallTile p={participant({ videoTrack: track, camOn: true })} />);

    expect(track.attach).toHaveBeenCalledTimes(2);
  });

  it("attaches to the NEW element, not the one that was unmounted", () => {
    const track = fakeTrack();
    const { rerender, container } = render(
      <CallTile p={participant({ videoTrack: track })} />,
    );
    rerender(<CallTile p={participant({ videoTrack: track, camOn: false })} />);
    rerender(<CallTile p={participant({ videoTrack: track, camOn: true })} />);

    const live = container.querySelector("video");
    expect(live).not.toBeNull();
    // Whatever it was handed last must be the element currently on screen.
    expect(track.attach).toHaveBeenLastCalledWith(live);
  });

  it("does not attach while the camera is off", () => {
    const track = fakeTrack();
    render(<CallTile p={participant({ videoTrack: track, camOn: false })} />);
    expect(track.attach).not.toHaveBeenCalled();
  });

  it("re-attaches when the underlying MediaStreamTrack is swapped", () => {
    // A camera re-acquired after being stopped hands back a new
    // MediaStreamTrack under the same publication. Staying bound to the old,
    // ended one renders as a blank tile too.
    const first = fakeTrack("stream-1");
    const { rerender } = render(<CallTile p={participant({ videoTrack: first })} />);

    const swapped = fakeTrack("stream-2");
    rerender(<CallTile p={participant({ videoTrack: swapped })} />);

    expect(swapped.attach).toHaveBeenCalledTimes(1);
  });

  it("shows a screen share in place of the camera, even with the camera off", () => {
    const screen = fakeTrack("screen-1");
    render(
      <CallTile p={participant({ screenTrack: screen, sharing: true, camOn: false })} />,
    );
    expect(screen.attach).toHaveBeenCalledTimes(1);
  });

  it("never plays the LOCAL user's own shared screen back at them — that is a video-feedback mirror, not a picture", () => {
    const screen = fakeTrack("screen-1");
    const { container } = render(
      <CallTile p={participant({ screenTrack: screen, sharing: true, isLocal: true })} />,
    );
    expect(screen.attach).not.toHaveBeenCalled();
    expect(container.querySelector("video")).toBeNull();
    expect(container.textContent).toContain("You're presenting your screen");
  });

  it("still shows a REMOTE participant's shared screen live, even when it happens to be pinned to the stage", () => {
    const screen = fakeTrack("screen-1");
    const { container } = render(
      <CallTile p={participant({ screenTrack: screen, sharing: true, isLocal: false })} size="stage" pinned />,
    );
    expect(screen.attach).toHaveBeenCalledTimes(1);
    expect(container.querySelector("video")).not.toBeNull();
  });

  it("detaches when the tile goes away, so the element is not left bound", () => {
    const track = fakeTrack();
    const { unmount } = render(<CallTile p={participant({ videoTrack: track })} />);
    unmount();
    expect(track.detach).toHaveBeenCalled();
  });
});

describe("CallTile audio attach", () => {
  it("attaches a remote participant's audio", () => {
    const audio = fakeTrack("mic-1");
    render(<CallTile p={participant({ audioTrack: audio })} />);
    expect(audio.attach).toHaveBeenCalledTimes(1);
  });

  it("NEVER plays your own microphone back at you", () => {
    // An unmuted local audio element is an echo loop.
    const audio = fakeTrack("mic-1");
    render(<CallTile p={participant({ audioTrack: audio, isLocal: true })} />);
    expect(audio.attach).not.toHaveBeenCalled();
  });

  it("re-attaches when a re-acquired microphone hands back a new stream", () => {
    const first = fakeTrack("mic-1");
    const { rerender } = render(<CallTile p={participant({ audioTrack: first })} />);
    const swapped = fakeTrack("mic-2");
    rerender(<CallTile p={participant({ audioTrack: swapped })} />);
    expect(swapped.attach).toHaveBeenCalledTimes(1);
  });
});
