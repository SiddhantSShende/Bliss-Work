/**
 * The in-call surface for a group call.
 *
 * Used for CHANNEL calls and MEETINGS. 1:1 DIRECT calls still run through
 * CallUI's peer connection until someone adds a third person, at which point
 * this takes over — the media topology has to change, because peer-to-peer with
 * three people means every client uploads two streams.
 *
 * ── The shape of the room ────────────────────────────────────────────────────
 * Controls at the top; below them, three fixed columns: the video area,
 * Participants, and — when open — Chat or Notes. The video area is the
 * largest of the three, and Participants stays on screen the whole time
 * rather than opening and closing like the other two, so "who is here" is
 * never a click away.
 *
 * With nobody on the stage, the video area shows everyone in a grid, paged
 * rather than scrolled: a call is a place you are in, and hunting for a face
 * by scrolling is not a thing to ask of someone who is also talking. Three or
 * four members sit in a small centered grid rather than the wider room's
 * responsive columns — see CallMembers.
 *
 * When anything is pinned — a shared screen automatically, or a person by
 * hand — that single tile fills the video area alone.
 *
 * Raised hands, the shared notes and the recording notice travel directly
 * between participants over the SFU's data channel (lib/roomMessages). They are
 * live-only state with no life after the meeting, which is exactly what that
 * channel is: the same audience, the same lifetime, and no table anywhere.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Circle,
  Clock,
  Globe,
  Hand,
  Mic,
  MicOff,
  MessageSquare,
  Minimize2,
  NotebookPen,
  PictureInPicture2,
  Video,
  VideoOff,
} from "lucide-react";
import { toast } from "sonner";
import { Button, cn } from "@taskboard/ui";
import { type CallDTO } from "@taskboard/shared";
import { useSession } from "../store/session";
import { useRuntime } from "../lib/runtime";
import { useCallRoom } from "../lib/useCallRoom";
import { CHAT_SYNC_MAX, NOTES_SYNC_MAX } from "../lib/roomMessages";
import {
  loadNotes,
  mergeNotes,
  notesFilename,
  notesToText,
  saveNotes,
  type NoteEntry,
} from "../lib/callNotes";
import {
  chatFilename,
  chatToText,
  loadChat,
  mergeChat,
  newChatEntry,
  saveChat,
  unreadSince,
  visibleToMe,
  visibleToPeer,
  type ChatEntry,
} from "../lib/callChat";
import {
  initialSpeakerState,
  pruneSpeakers,
  reduceActiveSpeaker,
  type SpeakerState,
} from "../lib/activeSpeaker";
import { useMeetingSessionOptional } from "../lib/MeetingSession";
import { useMeetingPiP } from "../lib/useMeetingPiP";
import { useMeetingDisplayController } from "../lib/useMeetingDisplayController";
import { useCallDuration } from "../lib/callTimer";
import { downloadBlob } from "../lib/download";
import { useLocalRecording } from "../lib/useLocalRecording";
import { MiniMeeting } from "./MiniMeeting";
import { CallControls, CallControlButton } from "./CallControls";
import { CallTile, UnpinButton } from "./CallTile";
import { CallMembers } from "./CallMembers";
import { CallSpeakerFilmstrip } from "./CallSpeakerFilmstrip";
import { SpeakingWave } from "./SpeakingWave";
import { CallNotes } from "./CallNotes";
import { CallChat } from "./CallChat";
import { CallRoster } from "./CallRoster";
import { ScreenSharePopup } from "./ScreenSharePopup";
import { AddPeopleDialog } from "./AddPeopleDialog";

/** Which panel is open in the right-hand column. One at a time: Chat and
 *  Notes share the column. Participants has its own fixed column and is not
 *  part of this toggle — see the render below. */
type Panel = "notes" | "chat" | null;

/** How often the active-speaker filter's clock is re-checked. PROMOTE_AFTER_MS
 *  and DEMOTE_AFTER_MS are time thresholds, and nothing marks time passing on
 *  its own — the SFU has no reason to send another event while nobody's
 *  speaking status has changed. Frequent enough that the silence timeout feels
 *  immediate against DEMOTE_AFTER_MS, cheap enough not to matter. */
const SPEAKER_TICK_MS = 250;

/** Participants and Chat/Notes share one constant so their widths can never
 *  drift apart — the layout calls for them to match exactly. */
const SIDE_PANEL_SIZE = "h-64 w-full shrink-0 lg:h-auto lg:w-72 xl:w-80";

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
  /**
   * Optional so this component can still be rendered on its own — the dev
   * preview harness does. Without a session there is nothing to minimise INTO,
   * so the room simply always shows itself.
   */
  const session = useMeetingSessionOptional();
  const [addOpen, setAddOpen] = useState(false);
  const [preJoin, setPreJoin] = useState(true);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [previewMicOn, setPreviewMicOn] = useState(true);
  const [previewCamOn, setPreviewCamOn] = useState(true);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const [starting, setStarting] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [hands, setHands] = useState<Set<string>>(() => new Set());
  const [notes, setNotes] = useState<NoteEntry[]>(() => loadNotes(call.id));
  const [chat, setChat] = useState<ChatEntry[]>(() => loadChat(call.id));
  /** Everything up to this moment has been read. Moved forward while the chat
   *  panel is open, so the badge counts only what arrived behind your back. */
  const [chatSeenAt, setChatSeenAt] = useState(() => Date.now());
  /** Who the room is listening to, filtered so a cough cannot take the stage. */
  const [speakers, setSpeakers] = useState<SpeakerState>(initialSpeakerState);
  /** THE ROOM is being recorded — by whoever pressed the button, which is not
   *  necessarily this client. Drives the notice everyone sees. The button's own
   *  state comes from `localRec` instead, because the recording is a file on
   *  one person's machine and only they can stop it.
   *
   *  Starts false even for a call already under way: a late joiner is told by
   *  the `recording` datagram the room answers their notes-request with, which
   *  is the same mechanism that carries a raised hand. */
  const [recording, setRecording] = useState(false);

  /**
   * Who is on the stage: the viewer's own pin if they made one, otherwise
   * whoever the room is listening to.
   *
   * The pin WINS, and that is the whole distinction — someone who chose a tile
   * deliberately should not lose it every time another person speaks. Unpinning
   * falls through to the active speaker again with no extra state, and because
   * `pinned` is this component's own state, one viewer's choice is invisible to
   * everybody else in the meeting.
   *
   * Computed here, ahead of the "waiting" early return below, because
   * useMeetingPiP (a hook) needs it and hooks cannot follow a conditional
   * return.
   */
  const stageId = pinned ?? speakers.active;
  const stage = stageId ? participants.find((p) => p.identity === stageId) : undefined;

  // What Picture-in-Picture follows: the same track CallTile would show on
  // the stage tile — a shared screen over a camera, and nothing at all when
  // the stage participant has neither on, mirroring CallTile's own showVideo
  // gate so the PiP button never claims to work for an avatar tile.
  //
  // Excludes the local sharer's own screen for the same reason CallTile
  // replaces it with a placeholder: a floating, always-on-top window showing
  // your own "Entire screen" capture sits inside the region being captured,
  // turning PiP into a second, worse copy of the video-feedback mirror.
  const pipTrack =
    stage && !(stage.isLocal && stage.sharing) && (stage.camOn || stage.sharing)
      ? stage.sharing
        ? stage.screenTrack
        : stage.videoTrack
      : null;
  const pip = useMeetingPiP(pipTrack, status === "connected" || status === "reconnecting");
  // The single source of truth for NORMAL/MINIMIZED/PICTURE_IN_PICTURE — see
  // lib/useMeetingDisplayController.ts for the whole state machine, including
  // how a USER_AWAY/USER_RETURNED signal from lib/userBehaviorAnalysis.ts
  // (this room's only subscriber of it) turns into an automatic PiP attempt
  // with a minimise fallback, and why "restore on return" is not always
  // NORMAL.
  const display = useMeetingDisplayController(
    session,
    pip,
    status === "connected" || status === "reconnecting",
  );
  const minimized = display.mode === "MINIMIZED";

  const title = call.title || (call.kind === "CHANNEL" ? "Channel call" : "Meeting");
  const meetingDuration = useCallDuration(connectedAt);

  /** Recording writes a file on THIS machine — see lib/localRecording.ts. The
   *  meeting is composited and encoded here rather than server-side, so the
   *  recording never leaves the organiser's computer. */
  const localRec = useLocalRecording(participants, title);

  useEffect(() => {
    if (!preJoin || !navigator.mediaDevices?.getUserMedia) return;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ audio: true, video: true })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        setPreviewStream(stream);
        if (previewVideoRef.current) previewVideoRef.current.srcObject = stream;
      })
      .catch(() => {
        setPreviewCamOn(false);
        setPreviewMicOn(false);
      });
    return () => {
      cancelled = true;
      setPreviewStream((stream) => {
        stream?.getTracks().forEach((track) => track.stop());
        return null;
      });
    };
  }, [preJoin]);

  useEffect(() => {
    if (previewVideoRef.current && previewStream) {
      previewVideoRef.current.srcObject = previewStream;
    }
  }, [previewStream]);

  const togglePreviewMic = () => {
    previewStream?.getAudioTracks().forEach((track) => {
      track.enabled = !previewMicOn;
    });
    setPreviewMicOn((on) => !on);
  };

  const togglePreviewCam = () => {
    previewStream?.getVideoTracks().forEach((track) => {
      track.enabled = !previewCamOn;
    });
    setPreviewCamOn((on) => !on);
  };
  const myName = participants.find((p) => p.isLocal)?.name || me?.displayName || "You";
  const handRaised = identity ? hands.has(identity) : false;
  // Only a HOST may record, and the server says so too — this gate exists so
  // nobody is shown a button that answers 403, not as the control itself.
  const isHost = call.participants.some((p) => p.userId === me?.id && p.role === "HOST");

  // Read by the data-channel subscriber, which is registered once and must not
  // close over a stale copy of what we hold.
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const handRef = useRef(handRaised);
  handRef.current = handRaised;
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  // Join once, after the pre-join lobby. The hook guards re-entry.
  useEffect(() => {
    if (preJoin) return;
    void join();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.id, preJoin]);

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

  // Same for the chat, for the same reason: a reload mid-meeting should not
  // lose the thread. Also no server copy — see lib/callChat.
  useEffect(() => {
    saveChat(call.id, chat);
  }, [call.id, chat]);

  /**
   * Who the stage should follow, when nobody has pinned anyone.
   *
   * Recomputed only when the SET of speakers changes, not on every room event:
   * `speaking` is joined into a string first so a re-render caused by anything
   * else — a track muting, someone's name arriving — cannot advance the
   * filter's clock and hand the stage over early.
   *
   * The local participant is excluded. You are already on screen in your own
   * tile, and promoting yourself the moment you speak takes the person you are
   * replying to off the stage mid-sentence.
   */
  const speakingKey = participants
    .filter((p) => p.speaking && !p.isLocal)
    .map((p) => p.identity)
    .sort()
    .join(",");
  // Read fresh by the tick below without making the tick's interval depend on
  // the speaking set — the interval itself is what re-evaluates the filter's
  // clock, not a change in who is reported speaking.
  const speakingRef = useRef<string[]>([]);
  speakingRef.current = speakingKey ? speakingKey.split(",") : [];

  useEffect(() => {
    setSpeakers((prev) => reduceActiveSpeaker(prev, speakingRef.current, Date.now()));
  }, [speakingKey]);

  // Time-aware on its own clock, not only when the SFU's reported speaking set
  // changes: a promotion that crosses PROMOTE_AFTER_MS, or a silence that
  // crosses DEMOTE_AFTER_MS, has to be caught even when nobody's speaking
  // status changes in between — otherwise a speaker who simply stopped talking
  // keeps the stage until somebody else happens to trigger a re-check.
  useEffect(() => {
    if (status !== "connected" && status !== "reconnecting") return;
    const id = setInterval(() => {
      setSpeakers((prev) => reduceActiveSpeaker(prev, speakingRef.current, Date.now()));
    }, SPEAKER_TICK_MS);
    return () => clearInterval(id);
  }, [status]);

  // An open panel is a read one: anything that lands while you are looking at
  // it has been seen, so the badge never counts what is already on screen.
  useEffect(() => {
    if (panel === "chat") setChatSeenAt(Date.now());
  }, [panel, chat.length]);

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
          case "chat":
            // The SFU only delivered this to people it was addressed to, so
            // this check is a second lock on the same door rather than the
            // one holding it — see lib/callChat.
            if (msg.msg.from !== from) break;
            setChat((prev) => mergeChat(prev, [msg.msg]));
            break;
          case "chat-request":
            // Answer the asker alone, and only with what they are party to: the
            // room's own messages, plus any direct exchange between us and
            // them. A private word with somebody ELSE is not ours to forward.
            sendData(
              {
                t: "chat-sync",
                msgs: chatRef.current
                  .filter((c) => visibleToPeer(c, from))
                  .slice(-CHAT_SYNC_MAX),
              },
              [from],
            );
            break;
          case "chat-sync":
            setChat((prev) => mergeChat(prev, msg.msgs));
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
    // Same handshake for the chat. Only what was said to the ROOM is offered
    // back: a direct message is the two parties' to re-send, and broadcasting
    // our copy of one would hand it to everybody who happens to be here now.
    sendData({ t: "chat-request" });
    const heldChat = chatRef.current.filter((c) => c.to === null);
    if (heldChat.length) sendData({ t: "chat-sync", msgs: heldChat.slice(-CHAT_SYNC_MAX) });
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
    // And so does the stage. pruneSpeakers returns the same object when nothing
    // changed, so this cannot loop.
    setSpeakers((prev) => pruneSpeakers(prev, present));
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

  /**
   * Say something to the room, or to one person.
   *
   * `to === null` publishes to everyone; otherwise the datagram carries a
   * single destination identity and the SFU delivers it to nobody else. Our own
   * copy is added locally either way — a sender is not among their own message's
   * destinations.
   */
  const sendChat = (text: string, to: string | null) => {
    if (!identity) return;
    const entry = newChatEntry({ from: identity, fromName: myName, to, text });
    setChat((prev) => mergeChat(prev, [entry]));
    sendData({ t: "chat", msg: entry }, to ? [to] : undefined);
  };

  const exportChat = () => {
    const nameOf = (id: string) =>
      participants.find((p) => p.identity === id)?.name ?? id;
    downloadBlob(
      new Blob([chatToText(title, chat, nameOf)], { type: "text/plain;charset=utf-8" }),
      chatFilename(title),
    );
  };

  /**
   * Start or stop recording the meeting to this machine.
   *
   * Local, so there is no request to fail and no deployment that can be
   * "unconfigured" — the only way this cannot work is a browser without
   * MediaRecorder, which `localRec.supported` answers before the click.
   *
   * The notice is broadcast either way, and separately from the capture: being
   * recorded is something the room must be told, and it must not depend on the
   * file having been written successfully.
   */
  const toggleRecording = async () => {
    if (localRec.recording) {
      setRecording(false);
      sendData({ t: "recording", on: false });
      await localRec.stop();
      toast("Recording saved to your downloads");
      return;
    }
    try {
      localRec.start();
    } catch {
      toast.error("This browser can't record meetings");
      return;
    }
    setRecording(true);
    sendData({ t: "recording", on: true });
    toast("Recording started — it will save to this device");
  };

  const hangUp = async () => {
    await leave();
    onClose();
  };

  if (preJoin) {
    const scheduledAt = call.scheduledAt;
    const scheduled = scheduledAt == null ? null : new Date(scheduledAt);
    const scheduledLabel = scheduled
      ? scheduled.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "Ready to join";

    return (
      <div className="meeting-theme fixed inset-0 z-[100] flex flex-col bg-surface text-fg">
        <header className="flex shrink-0 items-center justify-between border-b border-border/70 px-5 py-3">
          <div className="min-w-0">
            <div className="truncate font-semibold">{title}</div>
            <div className="text-xs text-muted">{scheduledLabel}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void hangUp()}>
            Leave
          </Button>
        </header>
        <main className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="w-full max-w-3xl rounded-2xl border border-border bg-surface-2/60 p-6 shadow-card">
            <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-bg ring-1 ring-border/60">
              <video
                ref={previewVideoRef}
                autoPlay
                muted
                playsInline
                className={`h-full w-full object-cover ${previewCamOn ? "" : "hidden"}`}
              />
              {!previewCamOn && (
                <div className="text-center text-muted">
                  <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-accent-soft text-2xl font-semibold text-accent">
                    {myName.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="text-sm">Your camera is off</div>
                </div>
              )}
              <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-surface/95 p-1.5 shadow-card">
                <button
                  type="button"
                  onClick={togglePreviewMic}
                  title={previewMicOn ? "Mute microphone" : "Unmute microphone"}
                  aria-label={previewMicOn ? "Mute microphone" : "Unmute microphone"}
                  className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors ${previewMicOn ? "bg-surface-2 text-fg hover:bg-border" : "bg-danger text-white hover:brightness-110"}`}
                >
                  {previewMicOn ? <Mic size={17} /> : <MicOff size={17} />}
                </button>
                <button
                  type="button"
                  onClick={togglePreviewCam}
                  title={previewCamOn ? "Turn camera off" : "Turn camera on"}
                  aria-label={previewCamOn ? "Turn camera off" : "Turn camera on"}
                  className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors ${previewCamOn ? "bg-surface-2 text-fg hover:bg-border" : "bg-danger text-white hover:brightness-110"}`}
                >
                  {previewCamOn ? <Video size={17} /> : <VideoOff size={17} />}
                </button>
              </div>
            </div>
            <div className="mt-5 flex flex-col items-center gap-3 text-center">
              <div>
                <h1 className="text-xl font-semibold">Ready to join?</h1>
                <p className="mt-1 text-sm text-muted">Check your camera and microphone before entering the meeting.</p>
              </div>
              <Button size="lg" onClick={() => setPreJoin(false)}>
                Join meeting
              </Button>
            </div>
          </div>
        </main>
      </div>
    );
  }

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
    // Deliberately NOT hidden when minimised. There is no meeting to float yet
    // — no media, nobody to show — so a minimised lobby would leave the user
    // with no meeting on screen and no way back to one. The minimise control is
    // not reachable from here, so this is a guard rather than a state the room
    // can normally be in.
    return (
      <div className="meeting-theme fixed inset-0 z-[100] flex flex-col items-center justify-center gap-5 bg-surface p-6 text-center">
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

  // Shared by the header's Add People control and the Participants panel's
  // Invite button — the same gate and the same explanation, wherever the
  // click happens. A channel call's roster IS the channel's membership: the
  // server would take the invite and then refuse the newcomer a token, which
  // is a dead end dressed up as an invitation. The way in is to be in the
  // channel.
  const canAddPeople = call.kind !== "CHANNEL" && (status === "connected" || status === "reconnecting");
  const addPeopleTitle =
    call.kind === "CHANNEL" ? "Everyone in the channel is already invited" : "Add people";

  // Only what this viewer is party to — the wire already guarantees it, and
  // this is the second lock (see lib/callChat).
  const visibleChat = identity ? chat.filter((c) => visibleToMe(c, identity)) : chat;
  const unread = panel === "chat" ? 0 : unreadSince(visibleChat, chatSeenAt, identity);

  return (
    <>
      {/* The meeting, small and on top, while the app is used underneath.
          Rendered as a SIBLING of the room rather than inside it: the room is
          hidden when minimised, and anything nested in it would be hidden too. */}
      {minimized && session && (
        <MiniMeeting
          title={title}
          stage={stage}
          participantCount={participants.length}
          status={status}
          micOn={micOn}
          camOn={camOn}
          unread={unread}
          connectedAt={connectedAt}
          onToggleMic={() => void toggleMic()}
          onToggleCam={() => void toggleCam()}
          onRestore={session.restore}
          onLeave={() => void hangUp()}
        />
      )}

      {/* HIDDEN, never unmounted. Unmounting is what disconnects the room and
          posts the leave (see useCallRoom's cleanup), so keeping this in the
          DOM is precisely what lets the meeting outlive a minimise. */}
      <div
        className={minimized ? "hidden" : "meeting-theme fixed inset-0 z-[100] flex flex-col bg-surface"}
      >
      <header className="shrink-0 space-y-3 border-b border-border/70 px-5 py-3">
        <div className="min-w-0">
          <div className="truncate font-semibold text-fg">{title}</div>
          <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted">
            {meetingDuration && (
              <span className="flex items-center gap-1">
                <Clock size={12} /> {meetingDuration}
              </span>
            )}
            {externals > 0 && (
              // Worth stating plainly: someone outside the organisation is in
              // the room, and that should never be something you have to infer.
              <span className="flex items-center gap-1 text-warning">
                <Globe size={12} /> {externals} external
              </span>
            )}
            {recording && (
              // Shown to EVERYONE, not only whoever pressed the button. Being
              // recorded is not something anyone should have to work out.
              <span className="flex items-center gap-1 font-medium text-danger">
                <Circle size={9} className="animate-pulse fill-current" /> Recording
              </span>
            )}
            {status === "reconnecting" && <span className="text-warning">Reconnecting…</span>}
            {status === "connecting" && <span>Connecting…</span>}
            {status === "failed" && <span className="text-danger">Couldn't connect</span>}
          </div>
        </div>

        <CallControls
          variant="surface"
          className="flex-wrap"
          micOn={micOn}
          camOn={camOn}
          sharing={sharing}
          startedAt={connectedAt}
          canAddPeople={canAddPeople}
          addPeopleTitle={addPeopleTitle}
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
                className={handRaised ? "bg-warning text-amber-950 hover:brightness-95" : undefined}
              >
                <Hand size={17} />
              </CallControlButton>

              <CallControlButton
                variant="surface"
                title={
                  panel === "chat"
                    ? "Hide chat"
                    : unread > 0
                      ? `Chat (${unread} new)`
                      : "Chat"
                }
                pressed={panel === "chat"}
                onClick={() => setPanel((p) => (p === "chat" ? null : "chat"))}
                className={panel === "chat" ? "bg-accent text-accent-fg" : undefined}
              >
                <span className="relative inline-flex">
                  <MessageSquare size={17} />
                  {/* The count, not just a dot: "someone said something" and
                      "eleven messages went by" are different situations to come
                      back to. Capped so the badge cannot grow the button. */}
                  {unread > 0 && (
                    <span
                      aria-hidden
                      className="absolute -right-2 -top-1.5 min-w-[15px] rounded-full bg-danger px-1 text-[9px] font-bold leading-[15px] text-white"
                    >
                      {unread > 9 ? "9+" : unread}
                    </span>
                  )}
                </span>
              </CallControlButton>

              {/* Offered to hosts alone — the organiser records the meeting.
                  Everyone still SEES the notice above.

                  `pressed` follows localRec, not `recording`: the latter is true
                  for everyone once anybody starts, and a host who is merely
                  being recorded by someone else has no file to stop. */}
              {isHost && (
                <CallControlButton
                  variant="surface"
                  title={
                    !localRec.supported
                      ? "This browser can't record meetings"
                      : localRec.recording
                        ? "Stop recording and save it to this device"
                        : "Record this meeting to this device"
                  }
                  pressed={localRec.recording}
                  disabled={!localRec.supported}
                  onClick={() => void toggleRecording()}
                  className={
                    localRec.recording ? "bg-danger text-white hover:brightness-90" : undefined
                  }
                >
                  <Circle size={17} className={localRec.recording ? "fill-current" : undefined} />
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

              {/* Only where the platform actually supports it — a button that
                  cannot work is worse than no button. Explicit click = a real
                  user gesture, so this is the reliable way in; leaving the tab
                  also attempts it, but browsers are free to refuse that one. */}
              {pip.supported && (
                <CallControlButton
                  variant="surface"
                  title={pip.active ? "Exit picture-in-picture" : "Picture-in-picture"}
                  pressed={pip.active}
                  onClick={pip.toggle}
                  className={pip.active ? "bg-accent text-accent-fg" : undefined}
                >
                  <PictureInPicture2 size={17} />
                </CallControlButton>
              )}

              {/* Offered only where there is somewhere to minimise INTO — the
                  session provider is what keeps the meeting running behind the
                  rest of the app. */}
              {session && (
                <CallControlButton
                  variant="surface"
                  title="Minimise — keep the meeting running while you work"
                  onClick={display.handleMinimize}
                >
                  <Minimize2 size={17} />
                </CallControlButton>
              )}
            </>
          }
        />
      </header>

      {/* Three fixed columns: video area, Participants, Chat/Notes — in that
          order and that width ratio at `lg` and up. Below `lg` there isn't
          room for three columns side by side, so they stack instead; nothing
          here ever overlays the video as a popup. */}
      <div className="relative flex min-h-0 flex-1 flex-col gap-3 p-4 lg:flex-row lg:gap-4">
        {/* Left: Active speaker / video area — always the largest section. */}
        <main className="glass relative flex min-h-0 flex-[3] flex-col gap-3 overflow-hidden rounded-2xl p-3">
          {/* The sharer's own reminder, and the only stop control that exists. */}
          {sharing && <ScreenSharePopup startedAt={connectedAt} onStop={() => void toggleShare()} />}

          {participants.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              {status === "failed" ? "Couldn't join this call." : "Connecting…"}
            </div>
          ) : stage ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="relative min-h-0 flex-1">
                {/* Offered only for a pin somebody MADE. The stage following
                    the speaker is the room's normal behaviour, and "unpin"
                    over a tile nobody pinned is a control with nothing to
                    undo. */}
                {pinned ? (
                  <UnpinButton name={stage.name} onClick={() => setPinned(null)} />
                ) : (
                  <span className="pointer-events-none absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
                    <Mic size={12} className="text-accent" />
                    <SpeakingWave className="text-accent" />
                    Speaking
                  </span>
                )}
                {/* `active`, not `p.speaking`: whoever is on the stage — by
                    speaking or by a manual pin — gets the highlight for as
                    long as they hold it, not just the instants they're
                    actually making sound. */}
                <CallTile p={stage} size="stage" active />
              </div>
              {/* Everyone else, small, below the stage rather than beside it
                  — see CallSpeakerFilmstrip for the five-tile cap and the
                  overflow card. Skipped when the stage participant is the
                  only one here: a thumbnail of the same lone face has
                  nothing to add. */}
              {participants.length > 1 && (
                <CallSpeakerFilmstrip
                  participants={participants}
                  activeId={stageId}
                  hands={hands}
                  pinned={pinned}
                  onTogglePin={togglePin}
                />
              )}
            </div>
          ) : (
            <CallMembers
              participants={participants}
              hands={hands}
              pinned={pinned}
              onTogglePin={togglePin}
              layout="grid"
            />
          )}
        </main>

        {/* Middle: Participants — a fixed part of the layout, not a panel
            that opens and closes, so "who is here" never needs a popup. */}
        <CallRoster
          participants={participants}
          hands={hands}
          pinned={pinned}
          onTogglePin={togglePin}
          canInvite={canAddPeople}
          inviteTitle={addPeopleTitle}
          onInvite={() => setAddOpen(true)}
          className={SIDE_PANEL_SIZE}
        />

        {/* Right: Chat or Notes — the two share this column, same as before. */}
        {panel && (
          <div className={cn("flex flex-col", SIDE_PANEL_SIZE)}>
            {panel === "notes" ? (
              <CallNotes
                notes={notes}
                onAdd={addNote}
                onExport={exportNotes}
                onClose={() => setPanel(null)}
              />
            ) : (
              <CallChat
                chat={visibleChat}
                participants={participants}
                me={identity}
                onSend={sendChat}
                onExport={exportChat}
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
        callId={call.id}
      />
      </div>
    </>
  );
}
