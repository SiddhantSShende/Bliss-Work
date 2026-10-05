/**
 * Every remote participant's voice must play exactly once, whatever the layout
 * happens to be showing.
 *
 * Audio used to be bound by CallTile, so it followed the tiles. With a stage the
 * active speaker is on screen twice (stage + filmstrip) and their track was
 * attached to two elements — the voice played doubled — while everyone past the
 * filmstrip's cap, and everyone on another page of the member grid, had no tile
 * at all and was silent.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { Track } from "livekit-client";
import type { RoomParticipant } from "../lib/useCallRoom";
import { CallAudioSinks } from "./CallAudioSinks";
import { CallMembers } from "./CallMembers";
import { CallSpeakerFilmstrip } from "./CallSpeakerFilmstrip";
import { CallTile } from "./CallTile";

function fakeTrack(id = "ms-track") {
  return { attach: vi.fn(), detach: vi.fn(), mediaStreamTrack: { id } } as unknown as Track & {
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
  };
}

function person(identity: string, over: Partial<RoomParticipant> = {}): RoomParticipant {
  return {
    identity,
    name: identity,
    isLocal: false,
    speaking: false,
    micOn: true,
    camOn: false,
    sharing: false,
    videoTrack: null,
    screenTrack: null,
    audioTrack: fakeTrack(),
    ...over,
  };
}

const audioOf = (p: RoomParticipant) => p.audioTrack as unknown as ReturnType<typeof fakeTrack>;

describe("CallAudioSinks", () => {
  it("plays each remote participant once, however many there are", () => {
    const room = Array.from({ length: 30 }, (_, i) => person(`u${i}`)); // far past any tile cap
    const { container } = render(<CallAudioSinks participants={room} />);

    expect(container.querySelectorAll("audio")).toHaveLength(30);
    for (const p of room) expect(audioOf(p).attach).toHaveBeenCalledTimes(1);
  });

  it("never plays the local microphone back", () => {
    const me = person("me", { isLocal: true });
    const { container } = render(<CallAudioSinks participants={[me]} />);

    expect(container.querySelectorAll("audio")).toHaveLength(0);
    expect(audioOf(me).attach).not.toHaveBeenCalled();
  });

  it("stops playing someone who leaves, and only them", () => {
    const [a, b] = [person("a"), person("b")];
    const { rerender } = render(<CallAudioSinks participants={[a, b]} />);

    rerender(<CallAudioSinks participants={[b]} />);

    expect(audioOf(a).detach).toHaveBeenCalledTimes(1);
    expect(audioOf(b).detach).not.toHaveBeenCalled();
  });

  it("re-binds when a participant's microphone track is replaced", () => {
    const first = person("a");
    const { rerender } = render(<CallAudioSinks participants={[first]} />);
    const swapped = { ...first, audioTrack: fakeTrack("ms-track-2") };

    rerender(<CallAudioSinks participants={[swapped]} />);

    expect(audioOf(first).detach).toHaveBeenCalledTimes(1);
    expect(audioOf(swapped).attach).toHaveBeenCalledTimes(1);
  });

  it("renders nothing for someone who has not published audio yet", () => {
    const quiet = person("a", { audioTrack: null });
    const { container } = render(<CallAudioSinks participants={[quiet]} />);

    expect(container.querySelectorAll("audio")).toHaveLength(0);
  });
});

describe("the tiles carry no audio of their own", () => {
  it("a stage tile does not attach its participant's voice", () => {
    const p = person("a");
    const { container } = render(<CallTile p={p} size="stage" active />);

    expect(container.querySelectorAll("audio")).toHaveLength(0);
    expect(audioOf(p).attach).not.toHaveBeenCalled();
  });

  it("the active speaker on the stage AND in the filmstrip is not attached twice", () => {
    const room = [person("a"), person("b"), person("c")];
    const { container } = render(
      <>
        <CallTile p={room[0]!} size="stage" active />
        <CallSpeakerFilmstrip
          participants={room}
          activeId="a"
          hands={new Set()}
          pinned={null}
          onTogglePin={() => {}}
        />
      </>,
    );

    expect(container.querySelectorAll("audio")).toHaveLength(0);
    for (const p of room) expect(audioOf(p).attach).not.toHaveBeenCalled();
  });

  it("the member grid does not attach voices either", () => {
    const room = Array.from({ length: 5 }, (_, i) => person(`u${i}`));
    const { container } = render(
      <CallMembers participants={room} hands={new Set()} pinned={null} onTogglePin={() => {}} />,
    );

    expect(container.querySelectorAll("audio")).toHaveLength(0);
    for (const p of room) expect(audioOf(p).attach).not.toHaveBeenCalled();
  });
});
