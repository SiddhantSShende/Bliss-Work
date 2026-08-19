/**
 * The in-call surface for a group call.
 *
 * Used for CHANNEL calls and MEETINGS. 1:1 DIRECT calls still run through
 * CallUI's peer connection until someone adds a third person, at which point
 * this takes over — the media topology has to change, because peer-to-peer with
 * three people means every client uploads two streams.
 *
 * ── The shape of the room ────────────────────────────────────────────────────
 * Controls at the top, members below them, panels to the right. The members
 * area is FIXED: it holds a page of twelve and pages the rest, rather than
 * growing a scrollbar — a call is a place you are in, and hunting for a face by
 * scrolling is not a thing to ask of someone who is also talking.
 *
 * When anything is pinned — a shared screen automatically, or a person by
 * hand — it takes the stage and the members compress into a strip ABOVE it, so
 * the room never disappears behind what it is looking at.
 *
 * Raised hands, the shared notes and the recording notice travel directly
 * between participants over the SFU's data channel (lib/roomMessages). They are
 * live-only state with no life after the meeting, which is exactly what that
 * channel is: the same audience, the same lifetime, and no table anywhere.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Circle, Clock, Globe, Hand, NotebookPen, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@taskboard/ui";
import { ApiError, type CallDTO } from "@taskboard/shared";
import { useSession } from "../store/session";
import { useRuntime } from "../lib/runtime";
import { useCallRoom } from "../lib/useCallRoom";
import { NOTES_SYNC_MAX } from "../lib/roomMessages";
import {
  loadNotes,
  mergeNotes,
  notesFilename,
  notesToText,
  saveNotes,
  type NoteEntry,
} from "../lib/callNotes";
import { downloadBlob } from "../lib/download";
import { CallControls, CallControlButton } from "./CallControls";
import { CallTile, UnpinButton } from "./CallTile";
import { CallMembers } from "./CallMembers";
import { CallNotes } from "./CallNotes";
import { CallRoster } from "./CallRoster";
import { ScreenSharePopup } from "./ScreenSharePopup";
import { AddPeopleDialog } from "./AddPeopleDialog";

/** Which side panel is open. One at a time: they share the column, and two
 *  panels on a laptop leaves the meeting itself a strip down the middle. */
type Panel = "notes" | "members" | null;

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
    sendData,
    onData,
    identity,
  } = room;
  const { api } = useRuntime();
  const me = useSession((s) => s.user);
  const [addOpen, setAddOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [hands, setHands] = useState<Set<string>>(() => new Set());
  const [notes, setNotes] = useState<NoteEntry[]>(() => loadNotes(call.id));
  const [recording, setRecording] = useState(call.recordingStatus === "RECORDING");
  // Latched once the server says it cannot record. Deployment config does not
  // change mid-call, so one refusal is enough to stop asking.
  const [recordingUnavailable, setRecordingUnavailable] = useState(false);

  const title = call.title || (call.kind === "CHANNEL" ? "Channel call" : "Meeting");
  const myName = participants.find((p) => p.isLocal)?.name || me?.displayName || "You";
  const handRaised = identity ? hands.has(identity) : false;
  // Only a HOST may record, and the server says so too — this gate exists so
  // nobody is shown a button that answers 403, not as the control itself.
  const isHost = call.participants.some((p) => p.userId === me?.id && p.role === "HOST");

  // Read by the data-channel subscriber, which is registered once and must not
  // close over a stale copy of what we hold.
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const handRef = useRef(handRaised);
  handRef.current = handRaised;
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

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

  // This browser's copy of the notes, so a reload mid-meeting does not lose the
  // list. There is no server copy — see lib/callNotes.
  useEffect(() => {
    saveNotes(call.id, notes);
  }, [call.id, notes]);

  /** Everything other participants say to this room. */
  useEffect(
    () =>
      onData((msg, from) => {
        switch (msg.t) {
          case "hand":
            setHands((prev) => {
              const next = new Set(prev);
              if (msg.raised) next.add(from);
              else next.delete(from);
              return next;
            });
            break;
          case "note":
            setNotes((prev) => mergeNotes(prev, [msg.note]));
            break;
          case "notes-request":
            // Answer the asker alone. Everyone present replies, and the
            // duplicates collapse on merge — cheaper than electing one of us.
            sendData({ t: "notes-sync", notes: notesRef.current.slice(-NOTES_SYNC_MAX) }, [from]);
            if (handRef.current) sendData({ t: "hand", raised: true }, [from]);
            if (recordingRef.current) sendData({ t: "recording", on: true }, [from]);
            break;
          case "notes-sync":
            setNotes((prev) => mergeNotes(prev, msg.notes));
            break;
          case "recording":
            setRecording(msg.on);
            break;
        }
      }),
    [onData, sendData],
  );

  // Ask what we missed, once we are actually in the room. A meeting in progress
  // has notes and hands that started before we arrived.
  //
  // And offer what we already hold, which is not nothing: a reload mid-meeting
  // restores this browser's copy from localStorage, and without this the person
  // who reloaded would be the only one still holding those points.
  const asked = useRef(false);
  useEffect(() => {
    if (status !== "connected" || asked.current) return;
    asked.current = true;
    sendData({ t: "notes-request" });
    const held = notesRef.current;
    if (held.length) sendData({ t: "notes-sync", notes: held.slice(-NOTES_SYNC_MAX) });
  }, [status, sendData]);

  /**
   * A shared screen takes the stage by itself.
   *
   * Only when the SHARER changes, so it is a one-time claim rather than a
   * policy: pin something else, or unpin, and the room leaves it alone until
   * somebody starts sharing next. When the share ends the stage is released —
   * but only if the share was what was on it, since by then the pin may be
   * somebody the viewer chose deliberately.
   */
  const sharer = participants.find((p) => p.sharing)?.identity ?? null;
  const lastSharer = useRef<string | null>(null);
  useEffect(() => {
    if (sharer && sharer !== lastSharer.current) setPinned(sharer);
    if (!sharer && lastSharer.current && pinnedRef.current === lastSharer.current) setPinned(null);
    lastSharer.current = sharer;
  }, [sharer]);

  // Someone pinned can leave. Their tile is gone; the pin must go with it, or
  // the stage renders nothing and the members stay squeezed into a strip.
  const identities = participants.map((p) => p.identity).join(",");
  useEffect(() => {
    const present = new Set(identities ? identities.split(",") : []);
    if (pinnedRef.current && !present.has(pinnedRef.current)) setPinned(null);
    // A hand belongs to someone who is here.
    setHands((prev) => {
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [identities]);

  const togglePin = useCallback((who: string) => {
    setPinned((prev) => (prev === who ? null : who));
  }, []);

  const toggleHand = () => {
    // Nothing to raise a hand in until we are in the room: the identity a hand
    // is keyed by is the one the SFU gave us.
    if (!identity) return;
    const next = !handRaised;
    setHands((prev) => {
      const s = new Set(prev);
      if (next) s.add(identity);
      else s.delete(identity);
      return s;
    });
    sendData({ t: "hand", raised: next });
  };

  const addNote = (text: string) => {
    const entry: NoteEntry = {
      // Unique without coordination: whose client wrote it, when, and a little
      // randomness for two points written inside the same millisecond.
      id: `${identity || "me"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      author: myName,
      text,
      at: Date.now(),
    };
    setNotes((prev) => mergeNotes(prev, [entry]));
    sendData({ t: "note", note: entry });
  };

  const exportNotes = () => {
    downloadBlob(
      new Blob([notesToText(title, notes)], { type: "text/plain;charset=utf-8" }),
      notesFilename(title),
    );
  };

  const toggleRecording = useMutation({
    mutationFn: async () => {
      if (recording) {
        await api.stopCallRecording(call.id);
        return false;
      }
      await api.startCallRecording(call.id);
      return true;
    },
    onSuccess: (on) => {
      setRecording(on);
      // Everyone else hears it now rather than at their next refetch, which
      // matters for the one notice nobody should see late.
      sendData({ t: "recording", on });
      toast(on ? "Recording started" : "Recording stopped");
    },
    onError: (e) => {
      // Switch on the CODE, not on the words in the message. The message is
      // prose the server is free to reword; matching it meant that the day the
      // server started answering "internal error" for an unconfigured recorder,
      // this silently fell through to the generic branch and told the user
      // nothing they could act on.
      const notEnabled = e instanceof ApiError && e.code === "service_unavailable";
      // Nothing the user does will make an unconfigured deployment record, so
      // stop offering it rather than letting them press it again.
      if (notEnabled) setRecordingUnavailable(true);
      toast.error(
        notEnabled
          ? "Recording isn't enabled on this server"
          : "Couldn't change the recording",
      );
    },
  });

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
          <div className="text-lg font-semibold text-fg">{title}</div>
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

  const externals = call.participants.filter((p) => p.external).length;
  const stage = pinned ? participants.find((p) => p.identity === pinned) : undefined;

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="shrink-0 space-y-3 border-b border-border/70 px-5 py-3">
        <div className="min-w-0">
          <div className="truncate font-semibold text-fg">{title}</div>
          <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted">
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
            {recording && (
              // Shown to EVERYONE, not only whoever pressed the button. Being
              // recorded is not something anyone should have to work out.
              <span className="flex items-center gap-1 font-medium text-red-500">
                <Circle size={9} className="animate-pulse fill-current" /> Recording
              </span>
            )}
            {status === "reconnecting" && <span className="text-amber-600">Reconnecting…</span>}
            {status === "connecting" && <span>Connecting…</span>}
            {status === "failed" && <span className="text-red-500">Couldn't connect</span>}
          </div>
        </div>

        <CallControls
          variant="surface"
          className="flex-wrap"
          micOn={micOn}
          camOn={camOn}
          sharing={sharing}
          startedAt={connectedAt}
          // A channel call's roster IS the channel's membership: the server
          // would take the row and then refuse the newcomer a token, which is a
          // dead end dressed up as an invitation. The way in is to be in the
          // channel.
          canAddPeople={
            call.kind !== "CHANNEL" && (status === "connected" || status === "reconnecting")
          }
          addPeopleTitle={
            call.kind === "CHANNEL" ? "Everyone in the channel is already invited" : "Add people"
          }
          onAddPeople={() => setAddOpen(true)}
          onToggleShare={() => void toggleShare()}
          onToggleMic={() => void toggleMic()}
          onToggleCam={() => void toggleCam()}
          onEnd={() => void hangUp()}
          extras={
            <>
              <CallControlButton
                variant="surface"
                title={handRaised ? "Lower your hand" : "Raise your hand"}
                pressed={handRaised}
                disabled={!identity}
                onClick={toggleHand}
                className={handRaised ? "bg-amber-400 text-amber-950 hover:bg-amber-300" : undefined}
              >
                <Hand size={17} />
              </CallControlButton>

              <CallControlButton
                variant="surface"
                title={panel === "members" ? "Hide members" : "Show members"}
                pressed={panel === "members"}
                onClick={() => setPanel((p) => (p === "members" ? null : "members"))}
                className={panel === "members" ? "bg-accent text-accent-fg" : undefined}
              >
                <Users size={17} />
              </CallControlButton>

              {/* Offered to hosts alone, because the server allows nobody else
                  to start or stop one. Everyone still SEES the notice above. */}
              {isHost && (
                <CallControlButton
                  variant="surface"
                  title={
                    recordingUnavailable
                      ? "Recording isn't enabled on this server"
                      : recording
                        ? "Stop recording"
                        : "Record this meeting"
                  }
                  pressed={recording}
                  disabled={toggleRecording.isPending || recordingUnavailable}
                  onClick={() => toggleRecording.mutate()}
                  className={recording ? "bg-red-500 text-white hover:bg-red-600" : undefined}
                >
                  <Circle size={17} className={recording ? "fill-current" : undefined} />
                </CallControlButton>
              )}

              <CallControlButton
                variant="surface"
                title={panel === "notes" ? "Hide notes" : "Notes"}
                pressed={panel === "notes"}
                onClick={() => setPanel((p) => (p === "notes" ? null : "notes"))}
                className={panel === "notes" ? "bg-accent text-accent-fg" : undefined}
              >
                <NotebookPen size={17} />
              </CallControlButton>
            </>
          }
        />
      </header>

      <div className="relative flex min-h-0 flex-1">
        <main className="relative flex min-h-0 flex-1 flex-col gap-3 p-4">
          {/* The sharer's own reminder, and the only stop control that exists. */}
          {sharing && <ScreenSharePopup startedAt={connectedAt} onStop={() => void toggleShare()} />}

          {participants.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              {status === "failed" ? "Couldn't join this call." : "Connecting…"}
            </div>
          ) : (
            <>
              {/* Members stay visible above whatever is pinned — the room does
                  not vanish behind the screen it is looking at. */}
              <CallMembers
                participants={participants}
                hands={hands}
                pinned={pinned}
                onTogglePin={togglePin}
                layout={stage ? "strip" : "grid"}
              />
              {stage && (
                <div className="relative min-h-0 flex-1">
                  <UnpinButton name={stage.name} onClick={() => setPinned(null)} />
                  <CallTile p={stage} size="stage" pinned />
                </div>
              )}
            </>
          )}
        </main>

        {/* Beside the room from `sm` up; over it on a phone, where a column and
            a video grid cannot both be usable. */}
        {panel && (
          <div className="absolute inset-0 z-20 flex bg-surface sm:relative sm:inset-auto sm:z-auto">
            {panel === "notes" ? (
              <CallNotes
                notes={notes}
                onAdd={addNote}
                onExport={exportNotes}
                onClose={() => setPanel(null)}
              />
            ) : (
              <CallRoster
                participants={participants}
                hands={hands}
                pinned={pinned}
                onTogglePin={togglePin}
                onClose={() => setPanel(null)}
              />
            )}
          </div>
        )}
      </div>

      <AddPeopleDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        exclude={onTheCall}
        onAdd={addPeople}
      />
    </div>
  );
}
