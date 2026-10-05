/**
 * Regression coverage for the "4 participants, only 3 visible" bug.
 *
 * The strip used to keep the stage participant IN its own list and bump them
 * to the front, so with a cap of three and four people in the room, one of
 * those three seats was always spent on a second copy of the face already
 * shown big on the stage — the fourth participant's camera had nowhere to go.
 * These prove the strip now leaves the stage OUT (its tile is reachable
 * elsewhere, on the big stage), except while it is a screen share, where the
 * sharer's own CAMERA — not a second copy of their screen — takes the seat
 * instead.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Track } from "livekit-client";
import type { RoomParticipant } from "../lib/useCallRoom";
import { CallSpeakerFilmstrip } from "./CallSpeakerFilmstrip";

function fakeTrack(id: string) {
  return { attach: vi.fn(), detach: vi.fn(), mediaStreamTrack: { id } } as unknown as Track & {
    attach: ReturnType<typeof vi.fn>;
  };
}

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

const attached = (t: Track | null) => (t as unknown as { attach: ReturnType<typeof vi.fn> }).attach;

const renderStrip = (participants: RoomParticipant[], activeId: string, limit?: number) =>
  render(
    <CallSpeakerFilmstrip
      participants={participants}
      activeId={activeId}
      hands={new Set()}
      pinned={null}
      onTogglePin={() => {}}
      limit={limit}
    />,
  );

describe("CallSpeakerFilmstrip — excluding the stage", () => {
  it("leaves the stage participant out, so all three OTHERS fit under a cap of three", () => {
    const room = [
      person("a", { camOn: true, videoTrack: fakeTrack("va") }),
      person("b", { camOn: true, videoTrack: fakeTrack("vb") }),
      person("c", { camOn: true, videoTrack: fakeTrack("vc") }),
      person("d", { camOn: true, videoTrack: fakeTrack("vd") }),
    ];

    renderStrip(room, "a", 3);

    // The stage's own face never gets a second tile here.
    expect(attached(room[0]!.videoTrack)).not.toHaveBeenCalled();
    // Every other camera in the room is reachable — the actual regression.
    expect(attached(room[1]!.videoTrack)).toHaveBeenCalledTimes(1);
    expect(attached(room[2]!.videoTrack)).toHaveBeenCalledTimes(1);
    expect(attached(room[3]!.videoTrack)).toHaveBeenCalledTimes(1);
    // Nobody was pushed into overflow by the duplicate that used to eat a seat.
    expect(screen.queryByText(/more members/i)).toBeNull();
  });

  it("still shows the lone other participant with only two in the room", () => {
    const room = [person("a", { camOn: true }), person("b", { camOn: true, videoTrack: fakeTrack("vb") })];

    renderStrip(room, "a", 3);

    expect(attached(room[1]!.videoTrack)).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/more members/i)).toBeNull();
  });

  it("still overflows correctly once there are more OTHERS than the cap allows", () => {
    const room = [
      person("a", { camOn: true }),
      person("b", { videoTrack: fakeTrack("vb") }),
      person("c", { videoTrack: fakeTrack("vc") }),
      person("d", { videoTrack: fakeTrack("vd") }),
      person("e", { videoTrack: fakeTrack("ve") }),
    ];

    renderStrip(room, "a", 3);

    // 4 others, cap 3 → exactly one left over, not two (participants.length
    // minus shown.length would have said two, double-counting the stage).
    expect(screen.getByText("+1 More members")).toBeInTheDocument();
  });
});

describe("CallSpeakerFilmstrip — a screen share on stage", () => {
  it("gives the sharer a seat showing their CAMERA, not a second copy of their screen", () => {
    const room = [
      person("a", {
        sharing: true,
        screenTrack: fakeTrack("screen-a"),
        camOn: true,
        videoTrack: fakeTrack("cam-a"),
      }),
      person("b", { camOn: true, videoTrack: fakeTrack("vb") }),
      person("c", { camOn: true, videoTrack: fakeTrack("vc") }),
      person("d", { camOn: true, videoTrack: fakeTrack("vd") }),
    ];

    renderStrip(room, "a", 4);

    // The screen is on the big stage tile already — showing it again here
    // would be the exact duplication this component now avoids elsewhere.
    expect(attached(room[0]!.screenTrack)).not.toHaveBeenCalled();
    // Their face is the new, genuinely additional information.
    expect(attached(room[0]!.videoTrack)).toHaveBeenCalledTimes(1);
    // And this doesn't cost anyone else their seat.
    expect(attached(room[1]!.videoTrack)).toHaveBeenCalledTimes(1);
    expect(attached(room[2]!.videoTrack)).toHaveBeenCalledTimes(1);
    expect(attached(room[3]!.videoTrack)).toHaveBeenCalledTimes(1);
  });

  it("falls back to the sharer's avatar in that seat when their camera is off", () => {
    const room = [
      person("a", { sharing: true, screenTrack: fakeTrack("screen-a"), camOn: false }),
      person("b", { camOn: true, videoTrack: fakeTrack("vb") }),
    ];

    const { container } = renderStrip(room, "a", 4);

    // No <video> for the sharer's seat — their camera is off — but they still
    // hold a seat (an avatar tile), not the excluded-entirely treatment a
    // non-sharing stage participant gets.
    expect(screen.getAllByText("A")).not.toHaveLength(0);
    expect(container.querySelectorAll("video")).toHaveLength(1); // only b's
  });
});
