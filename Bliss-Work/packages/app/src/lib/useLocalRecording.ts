/**
 * The room's side of recording to the organiser's own disk.
 *
 * Holds the one in-flight recording and keeps the grid it is drawing in step
 * with the meeting, so `localRecording.ts` can stay free of React and of any
 * knowledge of LiveKit.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  canRecordLocally,
  startLocalRecording,
  type LocalRecording,
  type RecordingTile,
} from "./localRecording";
import type { RoomParticipant } from "./useCallRoom";

/**
 * The roster as the compositor wants it.
 *
 * The two rules here are CallTile's, restated so the recording matches what
 * everyone was actually looking at: a shared screen wins the tile, and it is
 * letterboxed rather than cropped because a screen share is useless with its
 * edges cut off.
 */
export function tilesFrom(participants: RoomParticipant[]): RecordingTile[] {
  return participants.map((p) => {
    const shown = p.sharing ? p.screenTrack : p.videoTrack;
    const visible = p.camOn || p.sharing;
    return {
      name: p.name,
      video: visible ? (shown?.mediaStreamTrack ?? null) : null,
      audio: p.audioTrack?.mediaStreamTrack ?? null,
      letterbox: p.sharing,
    };
  });
}

export interface UseLocalRecording {
  /** True while a file is being captured. */
  recording: boolean;
  /** False on a browser with no MediaRecorder — the button says so rather than
   *  failing on click. */
  supported: boolean;
  /** Throws if recording cannot start; nothing is left running if it does. */
  start(): void;
  /** Ends it and saves the file. Resolves once the file has been handed over. */
  stop(): Promise<void>;
}

export function useLocalRecording(
  participants: RoomParticipant[],
  title: string,
): UseLocalRecording {
  const [recording, setRecording] = useState(false);
  const active = useRef<LocalRecording | null>(null);

  // Read at start() time rather than closed over, so the hook does not have to
  // be rebuilt on every roster change.
  const latest = useRef({ participants, title });
  latest.current = { participants, title };

  // The grid follows the meeting: people joining, leaving, turning a camera on
  // or starting a share all change what should be drawn from the next frame.
  useEffect(() => {
    active.current?.update(tilesFrom(participants));
  }, [participants]);

  const stop = useCallback(async () => {
    const current = active.current;
    if (!current) return;
    active.current = null;
    setRecording(false);
    await current.stop();
  }, []);

  const start = useCallback(() => {
    if (active.current) return;
    const { participants: people, title: name } = latest.current;
    const rec = startLocalRecording({
      tiles: tilesFrom(people),
      title: name,
      // The recording is already over by the time the encoder reports a
      // problem, so this puts the button back rather than trying to recover —
      // but it still has to be stopped: that is what releases the draw timer,
      // the AudioContext and the hidden video host (and saves what was captured).
      onError: () => {
        const failed = active.current;
        active.current = null;
        setRecording(false);
        void failed?.stop().catch(() => {});
      },
    });
    // Connects everyone's audio; startLocalRecording only takes the picture.
    rec.update(tilesFrom(people));
    active.current = rec;
    setRecording(true);
  }, []);

  // A meeting that ends while recording still yields its file. Without this the
  // capture would be torn down with the component and the whole recording lost
  // — which is the one outcome someone who pressed Record cannot forgive.
  useEffect(
    () => () => {
      void active.current?.stop();
      active.current = null;
    },
    [],
  );

  return { recording, supported: canRecordLocally(), start, stop };
}
