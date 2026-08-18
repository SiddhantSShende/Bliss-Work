import { useEffect, useRef, useState } from "react";
import { MicOff, ScreenShare, Users, Globe, Clock } from "lucide-react";
import { Button } from "@taskboard/ui";
import type { CallDTO } from "@taskboard/shared";
import { useSession } from "../store/session";
import { useCallRoom, type RoomParticipant } from "../lib/useCallRoom";
import { CallControls } from "./CallControls";
import { ScreenSharePopup } from "./ScreenSharePopup";
import { AddPeopleDialog } from "./AddPeopleDialog";

/** One participant tile.
 *
 *  The video element is attached imperatively because a MediaStreamTrack is not
 *  a React value — it is a live handle that has to be bound to the element and
 *  unbound when it changes, or the tile keeps rendering a track that has since
 *  been republished. */
function Tile({ p }: { p: RoomParticipant }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // A shared screen wins the tile: it is what the room is looking at, and it is
  // the one picture that is useless cropped, so it is letterboxed rather than
  // filled.
  const shown = p.sharing ? p.screenTrack : p.videoTrack;

  useEffect(() => {
    const el = videoRef.current;
    const track = shown;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [shown]);

  useEffect(() => {
    const el = audioRef.current;
    const track = p.audioTrack;
    // Never play your own microphone back at yourself.
    if (!el || !track || p.isLocal) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [p.audioTrack, p.isLocal]);

  return (
    <div
      className={`relative aspect-video overflow-hidden rounded-xl bg-surface-2 ring-2 transition-colors ${
        p.speaking ? "ring-accent" : "ring-transparent"
      }`}
    >
      {p.camOn || p.sharing ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          // Muting the local tile is not cosmetic: an unmuted local video
          // element is an echo loop.
          muted={p.isLocal}
          className={`h-full w-full ${p.sharing ? "bg-black object-contain" : "object-cover"}`}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-accent-soft text-lg font-semibold text-accent">
            {(p.name || "?").slice(0, 2).toUpperCase()}
          </div>
        </div>
      )}
      {!p.isLocal && <audio ref={audioRef} autoPlay />}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/60 to-transparent px-3 py-2">
        <span className="truncate text-xs font-medium text-white">
          {p.name}
          {p.isLocal && " (you)"}
        </span>
        {p.sharing && <ScreenShare size={12} className="shrink-0 text-red-400" />}
        {!p.micOn && <MicOff size={12} className="shrink-0 text-red-400" />}
      </div>
    </div>
  );
}

/**
 * The in-call surface for a group call.
 *
 * Used for CHANNEL calls and MEETINGS. 1:1 DIRECT calls still run through
 * CallUI's peer connection until someone adds a third person, at which point
 * this takes over — the media topology has to change, because peer-to-peer with
 * three people means every client uploads two streams.
 */
export function CallRoom({ call, onClose }: { call: CallDTO; onClose: () => void }) {
  const room = useCallRoom(call.id);
  const {
    join,
    leave,
    start,
    status,
    canStart,
    ended,
    participants,
    micOn,
    camOn,
    sharing,
    connectedAt,
    toggleMic,
    toggleCam,
    toggleShare,
    addPeople,
  } = room;
  const me = useSession((s) => s.user);
  const [addOpen, setAddOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  // Join once, on mount. The hook guards re-entry.
  useEffect(() => {
    void join();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.id]);

  // The host ended it. The hook has already disconnected and told the server we
  // are out, so this only has to close the screen — going through hangUp would
  // post a second leave for a call that is over.
  useEffect(() => {
    if (ended) onClose();
  }, [ended, onClose]);

  const externals = call.participants.filter((p) => p.external).length;

  const hangUp = async () => {
    await leave();
    onClose();
  };

  /**
   * The waiting room, rendered rather than merely tolerated.
   *
   * The server answers the token request with 202 and NO token until somebody
   * entitled to open the call does — that absence is the enforcement, and this
   * is the only screen that can explain it. Without it a participant who
   * arrives early sat on "Connecting…" indefinitely, and an organiser who
   * arrived by the same route had no way to start the call they were the one
   * holding up.
   *
   * `canStart` is the SERVER's answer, not a guess: it turns on org and channel
   * roles this client cannot see.
   */
  if (status === "waiting") {
    const startNow = () => {
      setStarting(true);
      void start().finally(() => setStarting(false));
    };
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5 bg-surface p-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <Clock size={24} />
        </div>
        <div className="max-w-sm">
          <div className="text-lg font-semibold text-fg">
            {call.title || (call.kind === "CHANNEL" ? "Channel call" : "Meeting")}
          </div>
          <p className="mt-1 text-sm text-muted">
            {canStart
              ? "You're the first one here. Start it to let everyone else in."
              : "This hasn't been opened yet. You'll join automatically the moment it starts."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void hangUp()}>
            Leave
          </Button>
          {canStart && (
            <Button size="sm" onClick={startNow} disabled={starting}>
              {starting ? "Starting…" : "Start now"}
            </Button>
          )}
        </div>
      </div>
    );
  }

  // Already on the roster, plus ourselves — nobody the picker offers should be
  // someone the server would refuse or silently ignore.
  const onTheCall = new Set(call.participants.map((p) => p.userId));
  if (me) onTheCall.add(me.id);

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <div className="min-w-0">
          <div className="truncate font-semibold text-fg">
            {call.title || (call.kind === "CHANNEL" ? "Channel call" : "Meeting")}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="flex items-center gap-1">
              <Users size={12} /> {participants.length}
            </span>
            {externals > 0 && (
              // Worth stating plainly: someone outside the organisation is in
              // the room, and that should never be something you have to infer.
              <span className="flex items-center gap-1 text-amber-600">
                <Globe size={12} /> {externals} external
              </span>
            )}
            {status === "reconnecting" && <span className="text-amber-600">Reconnecting…</span>}
            {status === "connecting" && <span>Connecting…</span>}
            {status === "failed" && <span className="text-red-500">Couldn't connect</span>}
          </div>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-auto p-4">
        {/* The sharer's own reminder, and the only stop control that exists. */}
        {sharing && <ScreenSharePopup startedAt={connectedAt} onStop={() => void toggleShare()} />}
        {participants.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted">
            {status === "failed" ? "Couldn't join this call." : "Connecting…"}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {participants.map((p) => (
              <Tile key={p.identity} p={p} />
            ))}
          </div>
        )}
      </div>

      <footer className="border-t border-border/70 px-5 py-3">
        <CallControls
          variant="surface"
          micOn={micOn}
          camOn={camOn}
          sharing={sharing}
          startedAt={connectedAt}
          // A channel call's roster IS the channel's membership: the server
          // would take the row and then refuse the newcomer a token, which is a
          // dead end dressed up as an invitation. The way in is to be in the
          // channel.
          canAddPeople={call.kind !== "CHANNEL" && (status === "connected" || status === "reconnecting")}
          addPeopleTitle={
            call.kind === "CHANNEL"
              ? "Everyone in the channel is already invited"
              : "Add people"
          }
          onAddPeople={() => setAddOpen(true)}
          onToggleShare={() => void toggleShare()}
          onToggleMic={() => void toggleMic()}
          onToggleCam={() => void toggleCam()}
          onEnd={() => void hangUp()}
        />
      </footer>

      <AddPeopleDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        exclude={onTheCall}
        onAdd={addPeople}
      />
    </div>
  );
}
