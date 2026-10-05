/**
 * The room's audio: one sink per remote participant, independent of what the
 * layout is showing.
 *
 * Audio used to be bound by CallTile, so it followed the tiles — which is wrong
 * in both directions. A participant shown twice (the active speaker on the stage
 * and again first in the filmstrip) had their track attached to two elements and
 * played doubled, while anyone with no tile mounted (past the filmstrip's cap,
 * on another page of the member grid) was silent. Who you can hear must not
 * depend on who fits on screen, so the sinks live here and tiles carry none.
 *
 * Mounted by CallRoom alongside — not inside — the visible layout, so it keeps
 * playing while the room is hidden behind the minimised meeting window.
 */
import { useEffect, useRef } from "react";
import type { RoomParticipant } from "../lib/useCallRoom";

export function CallAudioSinks({ participants }: { participants: RoomParticipant[] }) {
  return (
    <>
      {participants
        // Never play your own microphone back at yourself.
        .filter((p) => !p.isLocal && p.audioTrack)
        .map((p) => (
          <AudioSink key={p.identity} track={p.audioTrack} />
        ))}
    </>
  );
}

function AudioSink({ track }: { track: RoomParticipant["audioTrack"] }) {
  const ref = useRef<HTMLAudioElement>(null);
  // Un-muting a microphone can hand back a new MediaStreamTrack under the same
  // publication, so the Track wrapper's identity alone does not say when to
  // re-bind.
  const streamId = track?.mediaStreamTrack?.id;

  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track, streamId]);

  return <audio ref={ref} autoPlay />;
}
