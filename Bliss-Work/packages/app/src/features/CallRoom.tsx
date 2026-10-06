/**
 * The in-call surface for a group call.
 *
 * Used for CHANNEL calls and MEETINGS. 1:1 DIRECT calls still run through
 * CallUI's peer connection until someone adds a third person, at which point
 * this takes over — the media topology has to change, because peer-to-peer with
 * three people means every client uploads two streams.
 *
 * ── The shape of the room ────────────────────────────────────────────────────
 * A vertical sidebar (CallSidebar) holds every control — mic, camera, share,
 * hand, the three panel toggles, invite actions, recording, end call — rather
 * than splitting them across a header row and a bottom bar. Beside it: a
 * simple text header (title, participant count, status), then the main video
 * area next to whichever of Chat/Notes/Participants is open (CallSidePanel;
 * one column, three tabs, collapsing smoothly rather than popping open as an
 * overlay — see useCollapseTransition).
 *
 * ── The room is exactly the window ───────────────────────────────────────────
 * The shell is `fixed inset-0`: the box IS the viewport, so nothing inside it
 * can make the page taller than the window, whatever a camera's aspect ratio or
 * however many people are in the room. Every flex ancestor between the shell and
 * a tile carries `min-h-0`/`min-w-0` (a flex item will not shrink below its
 * content otherwise), and the video area's frames are inset-0 boxes with tiles
 * of definite size in them. Below `sm` the sidebar becomes a bottom dock (the
 * shell flips to a column), and below `md` the side panel becomes a sheet over
 * the stage.
 *
 * The video area itself takes one of two shapes depending on what the stage
 * actually is:
 *  - A speaking/pinned PERSON: their tile framed in BracketFrame, a vertical
 *    filmstrip of up to three others beside it.
 *  - A SCREEN SHARE: framed the same way, but with a horizontal filmstrip of
 *    up to four others below it instead — a wide capture and a side column
 *    fight each other for width; a row underneath doesn't.
 *  - Nobody on the stage: everyone in a paged grid (CallMembers), same frame.
 *
 * Raised hands, the shared notes and the recording notice travel directly
 * between participants over the SFU's data channel (lib/roomMessages). They are
 * live-only state with no life after the meeting, which is exactly what that
 * channel is: the same audience, the same lifetime, and no table anywhere.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Circle, Clock, Globe, Mic, MicOff, ScreenShare, Video, VideoOff } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Button, cn } from "@taskboard/ui";
import { type CallDTO } from "@taskboard/shared";
import { useSession } from "../store/session";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { isGetUserMediaDenied, useCallRoom } from "../lib/useCallRoom";
import { CAMERA_PREVIEW_CONSTRAINTS } from "../lib/mediaConstraints";
import { useVideoAspect } from "../lib/useVideoAspect";
import { useCollapseTransition } from "../lib/useCollapseTransition";
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
import { pickPipTrack, useMeetingPiP } from "../lib/useMeetingPiP";
import { useMeetingDisplayController } from "../lib/useMeetingDisplayController";
import { useCallDuration } from "../lib/callTimer";
import { useCallInviteLink } from "../lib/useCallInviteLink";
import { downloadBlob } from "../lib/download";
import { useLocalRecording } from "../lib/useLocalRecording";
import { MiniMeeting } from "./MiniMeeting";
import { BracketFrame } from "./BracketFrame";
import { CallSidebar } from "./CallSidebar";
import { CallAudioSinks } from "./CallAudioSinks";
import { UnpinButton } from "./CallTile";
import { CallTileHostProvider, CallTileSlot } from "./CallTileHost";
import { CallMembers } from "./CallMembers";
import { CallSpeakerFilmstrip } from "./CallSpeakerFilmstrip";
import { SpeakingWave } from "./SpeakingWave";
import { CallSidePanel } from "./CallSidePanel";
import { CallNotes } from "./CallNotes";
import { CallChat } from "./CallChat";
import { CallRoster } from "./CallRoster";
import { ScreenSharePopup } from "./ScreenSharePopup";
import { AddPeopleDialog } from "./AddPeopleDialog";

/** Which tab is open in the shared side panel. One at a time — Chat, Notes,
 *  and Participants all share the one column. */
type Panel = "notes" | "chat" | "participants" | null;

/** How often the active-speaker filter's clock is re-checked. PROMOTE_AFTER_MS
 *  and DEMOTE_AFTER_MS are time thresholds, and nothing marks time passing on
 *  its own — the SFU has no reason to send another event while nobody's
 *  speaking status has changed. Frequent enough that the silence timeout feels
 *  immediate against DEMOTE_AFTER_MS, cheap enough not to matter. */
const SPEAKER_TICK_MS = 250;

/** How long the side panel takes to slide open or collapse shut. Also how
 *  long it stays MOUNTED after closing (see useCollapseTransition) — keep the
 *  two in step, or it vanishes before its own closing transition finishes
 *  playing. */
const PANEL_TRANSITION_MS = 300;
/**
 * How the side panel is placed and sized, open and closed — three shapes,
 * chosen by breakpoint (the panel is a sibling of the video area, so its shape
 * is the room's, not the content's):
 *  - below `md` (768px): a sheet over the video area (`absolute`, inset to the
 *    content's edges). A split at this size leaves two surfaces neither of
 *    which is usable — a stage 100px tall, a chat 100px tall (a phone held
 *    sideways is 640–700px wide and only ~360px tall) — so the panel takes over
 *    instead, and the dock's own button (or the panel's ✕) puts the stage back.
 *  - `md` up to `lg`: a block stacked under the video area, capped at 16rem or
 *    half the space, whichever is less (so a short window keeps a usable stage) —
 *    but never below 13rem, the least at which its own header, notice and
 *    message box all fit — and collapsing on height.
 *  - `lg` and up: a column beside it, collapsing on width. `lg:h-auto
 *    lg:max-h-none` because a height cap does nothing there.
 * `overflow-hidden` keeps content from spilling out while it shrinks.
 */
const SIDE_PANEL_TRANSITION_BASE = "shrink-0 overflow-hidden transition-all duration-300 ease-out";
const SIDE_PANEL_SHEET =
  "absolute inset-x-3 bottom-3 top-0 z-30 sm:inset-x-6 sm:bottom-6 md:static md:z-auto md:w-full";
const SIDE_PANEL_OPEN = `${SIDE_PANEL_SHEET} opacity-100 md:min-h-52 md:max-h-[min(16rem,50%)] lg:h-auto lg:min-h-0 lg:max-h-none lg:w-72 xl:w-80`;
const SIDE_PANEL_CLOSED = `${SIDE_PANEL_SHEET} pointer-events-none opacity-0 md:max-h-0 lg:w-0`;

export function CallRoom({
  call: initialCall,
  onClose,
  autoJoin,
}: {
  call: CallDTO;
  onClose: () => void;
  /** Skip the pre-join lobby and apply this camera/mic state once the room
   *  connects — set when entered from the incoming-meeting popup's Video Call
   *  / Voice Call button (see MeetingHost, MeetingSession's `enter`).
   *  Undefined for every other entry point, which leaves the lobby exactly as
   *  it was. */
  autoJoin?: "video" | "voice";
}) {
  const { t, i18n } = useTranslation("callRoom");
  const room = useCallRoom(initialCall.id);
  const {
    join,
    leave,
    start,
    status,
    failStage,
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
  const { api, config } = useRuntime();
  /**
   * `initialCall` is a snapshot from whenever the caller opened this meeting
   * (MeetingSession's `enter()` sets it once and never again — see its own
   * doc). A meeting opened while still SCHEDULED keeps that frozen copy, with
   * no `startedAt`, for as long as this room stays mounted — even once the
   * host starts it and the meeting is genuinely LIVE.
   *
   * `qk.call(id)` is the same cache entry queryBridge.tsx already refreshes
   * on CallStarted/CallEnded/CallShareStarted/… (see handleCallEvent) for
   * every other surface (Meetings, MeetingDetail); this just adds the
   * observer that was missing here, so the room picks up that refresh too
   * instead of only whoever happens to revisit one of those. `initialData`
   * means the very first render is identical to before — nothing to load —
   * and it is ignored once the cache holds anything newer, so a late join or
   * a remount can never regress an already-fresher `startedAt` back to this
   * stale snapshot.
   */
  const { data: call } = useQuery({
    queryKey: qk.call(initialCall.id),
    queryFn: () => api.call(initialCall.id),
    initialData: initialCall,
  });
  const me = useSession((s) => s.user);
  /**
   * Optional so this component can still be rendered on its own — the dev
   * preview harness does. Without a session there is nothing to minimise INTO,
   * so the room simply always shows itself.
   */
  const session = useMeetingSessionOptional();
  const [addOpen, setAddOpen] = useState(false);
  const [preJoin, setPreJoin] = useState(() => !autoJoin);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [previewMicOn, setPreviewMicOn] = useState(true);
  const [previewCamOn, setPreviewCamOn] = useState(true);
  /** Why the preview has no stream: a denied permission vs. anything else
   *  (no device, already in use). Null while it hasn't failed (or hasn't
   *  been tried yet). */
  const [previewError, setPreviewError] = useState<"denied" | "other" | null>(null);
  /** Bumped by the "Try again" button to re-run the getUserMedia effect. */
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const previewAspect = useVideoAspect(previewVideoRef);
  const [starting, setStarting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  // Which tab the closing animation keeps showing underneath itself — `panel`
  // itself goes null immediately, but for the ~300ms it takes the panel to
  // fade out there still needs to be a real tab's content rendered inside it.
  const lastPanelRef = useRef<"chat" | "notes" | "participants">(panel ?? "chat");
  if (panel) lastPanelRef.current = panel;
  const { mounted: panelMounted, entered: panelEntered } = useCollapseTransition(
    panel !== null,
    PANEL_TRANSITION_MS,
  );
  const effectivePanel = panel ?? lastPanelRef.current;
  // Below `md` the open panel is a sheet laid over the stage (see SIDE_PANEL_*).
  // The sheet is translucent glass, so the stage would show through it and the
  // chat would be written over a moving picture; hidden (not unmounted — the
  // media keeps running) it is out of sight AND out of the tab order, which is
  // right for controls the sheet covers. The sharer's stop control lives in
  // <main> outside the stage, so it is not affected.
  const stageUnderSheet = panel !== null ? "max-md:invisible" : "";

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
   * A shared screen takes the stage over everything else, including a pin —
   * it is what the room is now looking at, not a suggestion. Read fresh from
   * `participants` on every render rather than latched into state anywhere:
   * there is then nothing about "who is sharing" that can go stale, and
   * nothing to restore once it stops — the stage just falls through to
   * `pinned`/the active speaker again on its own, taking with it whatever the
   * viewer had chosen before the share started. See CallSpeakerFilmstrip for
   * the other half (the sharer keeps a seat there too, showing their camera).
   */
  const sharer = participants.find((p) => p.sharing)?.identity ?? null;

  /**
   * Who is on the stage: a live screen share first, then the viewer's own
   * pin if they made one, otherwise whoever the room is listening to.
   *
   * The pin WINS over the active speaker, and that is the whole distinction —
   * someone who chose a tile deliberately should not lose it every time
   * another person speaks. Unpinning falls through to the active speaker again
   * with no extra state, and because `pinned` is this component's own state,
   * one viewer's choice is invisible to everybody else in the meeting.
   *
   * Computed here, ahead of the "waiting" early return below, because
   * useMeetingPiP (a hook) needs it and hooks cannot follow a conditional
   * return.
   */
  const stageId = sharer ?? pinned ?? speakers.active;
  const stage = stageId ? participants.find((p) => p.identity === stageId) : undefined;

  // What Picture-in-Picture follows: the track CallTile shows on the stage —
  // and, when the stage is an avatar with no picture, whoever in the room does
  // have one. See pickPipTrack, including why the local sharer's own screen is
  // never it.
  const pipTrack = pickPipTrack(stage, participants);
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

  const title = call.title || (call.kind === "CHANNEL" ? t("room.defaultTitleChannel") : t("room.defaultTitleMeeting"));
  // The MEETING's own start time, not this client's own connectedAt — every
  // participant's timer must read the same number regardless of when THEY
  // joined. call.startedAt is server-authoritative and kept fresh by the
  // live-refreshed `call` above, same source the Meetings list/detail
  // duration already reads (lib/meetingView.ts's durationMsOf).
  const meetingStartedAt = call.startedAt ? new Date(call.startedAt).getTime() : undefined;
  const meetingDuration = useCallDuration(meetingStartedAt);

  /** Recording writes a file on THIS machine — see lib/localRecording.ts. The
   *  meeting is composited and encoded here rather than server-side, so the
   *  recording never leaves the organiser's computer. */
  const localRec = useLocalRecording(participants, title);

  useEffect(() => {
    console.debug("[CALL ROOM] Mounted");
  }, []);

  useEffect(() => {
    if (!preJoin || !navigator.mediaDevices?.getUserMedia) return;
    let cancelled = false;
    setPreviewError(null);
    navigator.mediaDevices
      .getUserMedia({ audio: true, video: CAMERA_PREVIEW_CONSTRAINTS })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        setPreviewStream(stream);
        setPreviewCamOn(true);
        setPreviewMicOn(true);
        if (previewVideoRef.current) previewVideoRef.current.srcObject = stream;
      })
      .catch((e) => {
        // A stale attempt's rejection must not stomp a LATER attempt's
        // already-live preview — the same guard `.then()` above applies.
        // Without it, React StrictMode's mount→cleanup→mount (or any other
        // re-fire while a getUserMedia call is still pending) could have the
        // first, abandoned call's rejection land after the second call
        // already succeeded, flashing a false "blocked" error over a working
        // camera/mic that the user had genuinely granted.
        if (cancelled) return;
        setPreviewCamOn(false);
        setPreviewMicOn(false);
        setPreviewError(isGetUserMediaDenied(e) ? "denied" : "other");
      });
    return () => {
      cancelled = true;
      setPreviewStream((stream) => {
        stream?.getTracks().forEach((track) => track.stop());
        return null;
      });
    };
  }, [preJoin, previewAttempt, call.id]);

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
  const myName = participants.find((p) => p.isLocal)?.name || me?.displayName || t("room.youFallbackName");
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
  // Read by the before-quit effect below, which is mount-once so it does not
  // resubscribe on every render — it still needs the CURRENT leave/session.
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // The desktop app is about to quit. Neither a hang-up click nor a React
  // unmount is coming — the process can be torn down before either would run
  // — so this is the one chance to disconnect the room, tell the server we
  // left, and clear the "resume this meeting" marker before that happens.
  // Only present on Electron (see PlatformConfig.onBeforeQuit); a no-op on
  // web. Only subscribed while a meeting is actually up, since that is
  // exactly when this component is mounted.
  useEffect(() => {
    if (!config.onBeforeQuit) return;
    return config.onBeforeQuit(() => {
      void leaveRef.current({ awaitServer: true }).finally(() => {
        sessionRef.current?.exit();
        config.notifyQuitReady?.();
      });
    });
  }, [config]);

  // The desktop meeting window itself is being closed (OS close button, or
  // the main window's status pill's hang-up button) — the APP keeps running,
  // only this window is going away. Same reasoning and cleanup as the
  // before-quit effect above, and safe to fire from either without special
  // handling: `session` is already null here (this room only ever runs
  // inside a meeting window via MeetingSessionContext.Provider value={null}
  // — see routes/CallWindow.tsx), so sessionRef.current?.exit() is already a
  // no-op regardless of which of the two effects answers.
  useEffect(() => {
    if (!config.onBeforeWindowClose) return;
    return config.onBeforeWindowClose(() => {
      void leaveRef.current({ awaitServer: true }).finally(() => {
        sessionRef.current?.exit();
        config.notifyWindowCloseReady?.();
      });
    });
  }, [config]);

  // Keep the main window's status pill (features/MeetingWindowStatusBar)
  // in step — no-op everywhere but the meeting window, where this is present.
  // Pushed on change rather than polled: the pill computes its own elapsed
  // time locally off `startedAt` (same useCallDuration this room uses), so
  // it only needs a fresh push when something ELSE actually changed.
  useEffect(() => {
    config.pushMeetingWindowStatus?.({
      callId: call.id,
      title,
      micOn,
      camOn,
      startedAt: meetingStartedAt,
      participantCount: participants.length,
    });
  }, [config, call.id, title, micOn, camOn, meetingStartedAt, participants.length]);

  // Join once, after the pre-join lobby. The hook guards re-entry.
  useEffect(() => {
    if (preJoin) return;
    void join();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.id, preJoin]);

  // The incoming-meeting popup's Video Call / Voice Call choice (`autoJoin`),
  // applied once the room actually connects. toggleCam/toggleMic are the ONLY
  // way to publish either track (see useCallRoom's join, which always
  // connects muted and camera-off), so there is nothing to pass into join()
  // itself — this is the post-connect equivalent of clicking the same control
  // a person would click by hand once in the room.
  const autoJoinAppliedRef = useRef(false);
  useEffect(() => {
    autoJoinAppliedRef.current = false;
  }, [call.id]);
  useEffect(() => {
    if (!autoJoin || autoJoinAppliedRef.current || status !== "connected") return;
    autoJoinAppliedRef.current = true;
    if (autoJoin === "video") void toggleCam();
    else void toggleMic();
  }, [autoJoin, status, toggleCam, toggleMic]);

  // The lobby's own mic/camera choice (previewMicOn/previewCamOn), applied
  // once the room connects. Those two only ever drove the standalone preview
  // stream above — join() always connects muted and camera-off (see
  // useCallRoom's join) — so without this the lobby's toggles were pure
  // decoration and everyone arrived off regardless of what they picked. Same
  // "press the control once, post-connect" shape as the autoJoin effect
  // above, and mutually exclusive with it: autoJoin skips the lobby entirely
  // (preJoin starts false), so previewMicOn/previewCamOn never left their
  // defaults in that case and must not be applied on top.
  const lobbyPrefsAppliedRef = useRef(false);
  useEffect(() => {
    lobbyPrefsAppliedRef.current = false;
  }, [call.id]);
  useEffect(() => {
    if (autoJoin || preJoin || lobbyPrefsAppliedRef.current || status !== "connected") return;
    lobbyPrefsAppliedRef.current = true;
    if (previewMicOn) void toggleMic();
    if (previewCamOn) void toggleCam();
  }, [autoJoin, preJoin, status, previewMicOn, previewCamOn, toggleMic, toggleCam]);

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

  /**
   * Keep one entry on the server as well as on the wire.
   *
   * Fire and forget, and deliberately so: the data channel is what the room
   * sees, and it has already carried this entry to everybody by the time this
   * runs. A meeting must not break — or make anybody wait — because the
   * transcript write was slow, or offline, or talking to a deployment that
   * predates it. A failure is logged and the meeting carries on; the entry is
   * simply not in the record.
   *
   * Each client keeps only what IT wrote. The server refuses a line written in
   * somebody else's name, and one poster per entry is one request per entry
   * rather than one per participant per entry.
   */
  const keep = (what: "chat" | "note", entry: { id: string; text: string; at: number }) => {
    const save = what === "chat" ? api.saveCallChat(call.id, entry) : api.saveCallNote(call.id, entry);
    void save.catch((err: unknown) => {
      console.warn(`[meeting] could not keep this ${what} in the record`, err);
    });
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
    keep("note", { id: entry.id, text: entry.text, at: entry.at });
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
    // ROOM-WIDE ONLY. A direct message was transmitted to one identity and to
    // nobody else; writing it down would make it readable by everyone the
    // meeting's record admits, which is not what the sender chose when they
    // picked one person out of the "To:" list. The server has nowhere to put
    // one either — see messaging-svc migration 0029.
    if (to === null) keep("chat", { id: entry.id, text: entry.text, at: entry.at });
  };

  const exportChat = () => {
    const nameOf = (id: string) =>
      participants.find((p) => p.identity === id)?.name ?? id;
    // Same privacy filter as the on-screen panel (visibleChat, below) — the
    // exported transcript must not contain anything the viewer isn't party to.
    downloadBlob(
      new Blob([chatToText(title, visibleChat, nameOf)], { type: "text/plain;charset=utf-8" }),
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
      toast(t("room.toasts.recordingSaved"));
      return;
    }
    try {
      localRec.start();
    } catch {
      toast.error(t("room.toasts.recordingUnsupported"));
      return;
    }
    setRecording(true);
    sendData({ t: "recording", on: true });
    toast(t("room.toasts.recordingStarted"));
  };

  // Mint (once) and copy a link anyone can use to join this call — shared
  // with MeetingInviteLink's own invite control outside the room, see
  // lib/useCallInviteLink.
  const { isPending: mintingInviteLink, copyLink: copyInviteLinkUrl } = useCallInviteLink(call.id);
  const copyInviteLink = async () => {
    if (await copyInviteLinkUrl()) toast(t("room.toasts.inviteLinkCopied"));
  };

  const hangUp = async () => {
    await leave();
    onClose();
  };

  if (preJoin) {
    // What the preview box is shaped like: the camera's own aspect ratio while
    // there is a picture, clamped between 9:16 and 16:9 — every ordinary camera
    // shape, portrait phone streams included, fills its box exactly; only an
    // ultrawide gets (small) bars rather than a box too flat to look at.
    // The <video> stays mounted whatever the camera is doing (its srcObject is
    // bound once, in an effect), and is only hidden — so this reads the same
    // element for the whole lobby.
    const previewShowsVideo = previewCamOn && !previewError;
    const previewBoxAspect =
      previewShowsVideo && previewAspect ? Math.min(16 / 9, Math.max(9 / 16, previewAspect)) : 16 / 9;
    const scheduledAt = call.scheduledAt;
    const scheduled = scheduledAt == null ? null : new Date(scheduledAt);
    const scheduledLabel = scheduled
      ? scheduled.toLocaleString(i18n.language, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : t("preJoin.readyToJoinLabel");

    return (
      <div className="meeting-surface meeting-theme meeting-mesh fixed inset-0 z-[100] flex flex-col text-fg">
        <header className="flex shrink-0 items-center justify-between border-b border-border/70 px-5 py-3">
          <div className="min-w-0">
            <div className="truncate font-semibold">{title}</div>
            <div className="text-xs text-muted">{scheduledLabel}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void hangUp()}>
            {t("preJoin.leave")}
          </Button>
        </header>
        <main className="flex min-h-0 flex-1 items-center justify-center p-3 sm:p-6">
          {/* The lobby card is ONE bounded box: as tall as the window leaves room
              for, up to a comfortable 40rem. `h-[min(100%,40rem)]` is a DEFINITE
              height — `main` above is a flex-1/min-h-0 box under a fixed shell —
              and that is what lets the preview below be sized by what is LEFT
              after the heading and the Join button, instead of by its own
              content. Both of those are shrink-0, so Join is on screen at every
              size; overflow-y-auto is only the backstop for a window too small
              for even that.

              Portrait windows stack the preview over the heading and Join;
              landscape ones put them side by side (the window is short there,
              and the row is what keeps the preview from being squeezed to a
              strip). */}
          <div className="glass flex h-[min(100%,40rem)] w-full max-w-6xl flex-col gap-4 overflow-y-auto rounded-2xl p-4 sm:p-6 landscape:flex-row landscape:items-stretch">
            <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
              {/* The space the preview may use. [container-type:size] makes its
                  own size available to the box inside as `cqw`/`cqh`, which is
                  what lets that box be "as large as fits, at this aspect ratio"
                  — something no combination of aspect-ratio and max-height can
                  say, because a max-height that clamps the height leaves the
                  width behind and breaks the ratio (the black side bars). */}
              <div className="flex min-h-0 flex-1 items-center justify-center [container-type:size]">
                <div
                  className="relative flex max-h-full max-w-full items-center justify-center overflow-hidden rounded-xl bg-bg ring-1 ring-border/60"
                  // The camera's OWN aspect ratio (clamped so an extreme one
                  // cannot make the box a sliver), so the picture fills its
                  // box exactly: no bars for a 4:3 or portrait camera. 16:9
                  // while there is no picture (camera off, or an error).
                  style={{
                    aspectRatio: previewBoxAspect,
                    width: `min(100cqw, calc(100cqh * ${previewBoxAspect}))`,
                  }}
                >
                  <video
                    ref={previewVideoRef}
                    autoPlay
                    muted
                    playsInline
                    className={`h-full w-full -scale-x-100 object-contain ${previewShowsVideo ? "" : "hidden"}`}
                  />
                  {!previewCamOn && !previewError && (
                    <div className="text-center text-muted">
                      <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-accent-soft text-2xl font-semibold text-accent">
                        {myName.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="text-sm">{t("preJoin.cameraOffPlaceholder")}</div>
                    </div>
                  )}
                  {previewError && (
                    <div className="max-w-xs px-4 text-center text-muted">
                      <AlertCircle className="mx-auto mb-2 text-danger" size={28} />
                      <div className="text-sm font-medium text-fg">
                        {previewError === "denied"
                          ? t("preJoin.error.deniedTitle")
                          : t("preJoin.error.otherTitle")}
                      </div>
                      <p className="mt-1 text-xs">
                        {previewError === "denied"
                          ? t("preJoin.error.deniedHint")
                          : t("preJoin.error.otherHint")}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setPreviewAttempt((n) => n + 1)}>
                          {t("preJoin.error.tryAgain")}
                        </Button>
                        {previewError === "denied" && config.openCameraSettings && (
                          <Button size="sm" variant="ghost" onClick={() => void config.openCameraSettings!()}>
                            {t("preJoin.error.openCameraSettings")}
                          </Button>
                        )}
                        {previewError === "denied" && config.openMicrophoneSettings && (
                          <Button size="sm" variant="ghost" onClick={() => void config.openMicrophoneSettings!()}>
                            {t("preJoin.error.openMicrophoneSettings")}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              {/* Under the picture, never over it: over it they sat on the face
                  and on whatever the error state was saying. One fixed place,
                  whatever the preview is showing. */}
              <div className="flex shrink-0 items-center justify-center gap-2 self-center rounded-full border border-border bg-surface/95 p-1.5 shadow-card">
                <button
                  type="button"
                  onClick={togglePreviewMic}
                  title={previewMicOn ? t("preJoin.muteMic") : t("preJoin.unmuteMic")}
                  aria-label={previewMicOn ? t("preJoin.muteMic") : t("preJoin.unmuteMic")}
                  className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors ${previewMicOn ? "bg-surface-2 text-fg hover:bg-border" : "bg-danger text-white hover:brightness-110"}`}
                >
                  {previewMicOn ? <Mic size={17} /> : <MicOff size={17} />}
                </button>
                <button
                  type="button"
                  onClick={togglePreviewCam}
                  title={previewCamOn ? t("preJoin.cameraOff") : t("preJoin.cameraOn")}
                  aria-label={previewCamOn ? t("preJoin.cameraOff") : t("preJoin.cameraOn")}
                  className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors ${previewCamOn ? "bg-surface-2 text-fg hover:bg-border" : "bg-danger text-white hover:brightness-110"}`}
                >
                  {previewCamOn ? <Video size={17} /> : <VideoOff size={17} />}
                </button>
              </div>
            </section>
            <section className="flex shrink-0 flex-col items-center justify-center gap-3 text-center landscape:w-56 lg:landscape:w-72">
              <div>
                <h1 className="text-xl font-semibold">{t("preJoin.heading")}</h1>
                {/* The one piece that can go on a very short window: the heading
                    and the button are what the screen is for. */}
                <p className="mt-1 text-sm text-muted [@media(max-height:480px)]:hidden">{t("preJoin.description")}</p>
              </div>
              <Button size="lg" onClick={() => setPreJoin(false)}>
                {t("preJoin.joinButton")}
              </Button>
            </section>
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
      <div className="meeting-theme meeting-mesh fixed inset-0 z-[100] flex flex-col items-center justify-center gap-5 p-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <Clock size={24} />
        </div>
        <div className="max-w-sm">
          <div className="text-lg font-semibold text-fg">{title}</div>
          <p className="mt-1 text-sm text-muted">
            {canStart
              ? t("waitingRoom.canStartHint")
              : t("waitingRoom.waitingHint")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void hangUp()}>
            {t("waitingRoom.leave")}
          </Button>
          {canStart && (
            <Button size="sm" onClick={startNow} disabled={starting}>
              {starting ? t("waitingRoom.starting") : t("waitingRoom.startNow")}
            </Button>
          )}
        </div>
      </div>
    );

  }

  /**
   * The join attempt failed — a token refusal, or `room.connect` timing out
   * against LiveKit's own signalling/media timeouts (see useCallRoom's join)
   * — OR a call already under way was dropped outright: LiveKit's own
   * reconnection (see the "Reconnecting…" state below) gave up recovering
   * it. That last case is not an ordinary leave, so it must not look like
   * one either: without landing here, the participant was left staring at a
   * bare "Connecting…" placeholder with every control silently no-op'ing on
   * a null room.
   *
   * Rendered as its own screen rather than falling through to the room chrome:
   * that chrome's sidebar (mic/camera/share) has nothing to control without a
   * room and every button on it silently no-ops, which reads as the app being
   * stuck rather than the join having failed. `retry` re-enters `join()`
   * directly — the hook already resets `roomRef`/`joining` on the failure path
   * (see useCallRoom.ts), so a second call is a clean re-attempt.
   */
  if (status === "switch_required") {
    return (
      <div className="meeting-theme meeting-mesh fixed inset-0 z-[100] flex flex-col items-center justify-center gap-5 p-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <AlertCircle size={24} />
        </div>
        <div className="max-w-sm">
          <div className="text-lg font-semibold text-fg">{t("joinFailed.anotherDeviceTitle")}</div>
          <p className="mt-1 text-sm text-muted">{t("joinFailed.anotherDeviceHint")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void hangUp()}>
            {t("joinFailed.leave")}
          </Button>
          <Button size="sm" onClick={() => void join({ switchHere: true })}>
            {t("joinFailed.switchHere")}
          </Button>
        </div>
      </div>
    );
  }

  if (status === "failed") {
    const retry = () => {
      setRetrying(true);
      void join().finally(() => setRetrying(false));
    };
    const failTitle =
      failStage === "token"
        ? t("joinFailed.tokenTitle")
        : failStage === "disconnected"
          ? t("joinFailed.disconnectedTitle")
          : failStage === "displaced"
            ? t("joinFailed.displacedTitle")
            : t("joinFailed.genericTitle");
    const failHint =
      failStage === "token"
        ? t("joinFailed.tokenHint")
        : failStage === "disconnected"
          ? t("joinFailed.disconnectedHint")
          : failStage === "displaced"
            ? t("joinFailed.displacedHint")
            : t("joinFailed.genericHint");
    return (
      <div className="meeting-theme meeting-mesh fixed inset-0 z-[100] flex flex-col items-center justify-center gap-5 p-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-danger/10 text-danger">
          <AlertCircle size={24} />
        </div>
        <div className="max-w-sm">
          <div className="text-lg font-semibold text-fg">{failTitle}</div>
          <p className="mt-1 text-sm text-muted">{failHint}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void hangUp()}>
            {t("joinFailed.leave")}
          </Button>
          {failStage !== "displaced" && (
            <Button size="sm" onClick={retry} disabled={retrying}>
              {retrying ? t("joinFailed.retrying") : t("joinFailed.retry")}
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

  // Shared by the sidebar's Add and Invite buttons — the same gate and the
  // same explanation, wherever the click happens. A channel call's roster IS
  // the channel's membership: the server would take the invite and then
  // refuse the newcomer a token, which is a dead end dressed up as an
  // invitation. The way in is to be in the channel.
  const canAddPeople = call.kind !== "CHANNEL" && (status === "connected" || status === "reconnecting");
  const addPeopleTitle =
    call.kind === "CHANNEL" ? t("room.channelAlreadyInvited") : t("room.addPeopleDefaultTitle");

  // Only what this viewer is party to — the wire already guarantees it, and
  // this is the second lock (see lib/callChat).
  const visibleChat = identity ? chat.filter((c) => visibleToMe(c, identity)) : chat;
  const unread = panel === "chat" ? 0 : unreadSince(visibleChat, chatSeenAt, identity);

  return (
    <>
      {/* Everyone's voice, once each — not tied to which tiles the layout shows
          (see CallAudioSinks). A sibling of the hidden room, like MiniMeeting,
          so it plays whether the room is visible or minimised. */}
      <CallAudioSinks participants={participants} />

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
          startedAt={meetingStartedAt}
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
        className={minimized ? "hidden" : "meeting-surface meeting-theme meeting-mesh fixed inset-0 z-[100] flex min-h-0 min-w-0 flex-col-reverse text-fg sm:flex-row"}
      >
        <CallSidebar
          micOn={micOn}
          onToggleMic={() => void toggleMic()}
          camOn={camOn}
          onToggleCam={() => void toggleCam()}
          sharing={sharing}
          onToggleShare={() => void toggleShare()}
          handRaised={handRaised}
          canRaiseHand={!!identity}
          onToggleHand={toggleHand}
          participantsActive={panel === "participants"}
          onToggleParticipants={() => setPanel((p) => (p === "participants" ? null : "participants"))}
          canAddPeople={canAddPeople}
          addPeopleTitle={addPeopleTitle}
          onAddPeople={() => setAddOpen(true)}
          canInviteLink={canAddPeople}
          inviteLinkTitle={addPeopleTitle}
          mintingInviteLink={mintingInviteLink}
          onCopyInviteLink={() => void copyInviteLink()}
          chatActive={panel === "chat"}
          unreadChat={unread}
          onToggleChat={() => setPanel((p) => (p === "chat" ? null : "chat"))}
          notesActive={panel === "notes"}
          onToggleNotes={() => setPanel((p) => (p === "notes" ? null : "notes"))}
          isHost={isHost}
          recordingSupported={localRec.supported}
          recording={localRec.recording}
          onToggleRecording={() => void toggleRecording()}
          pipSupported={pip.supported}
          pipAvailable={pip.available}
          pipActive={pip.active}
          onTogglePip={pip.toggle}
          onMinimize={session ? display.handleMinimize : undefined}
          onEnd={() => void hangUp()}
        />

        {/* min-w-0: this is a flex-ROW child of the sidebar+content shell
            above. Flex items default to min-width:auto (their content's
            intrinsic width), which without this stops the panel shrinking
            below that at a narrow window width — the classic cause of
            horizontal overflow in a flex row. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="shrink-0 px-3 py-2 sm:px-6 sm:py-4">
            <div className="truncate text-base font-semibold uppercase tracking-wide text-fg">
              {title}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted">
              <span>
                {t("room.header.participantsPresent", { count: participants.length })}
              </span>
              {meetingDuration && (
                <span className="flex items-center gap-1">
                  <Clock size={12} /> {meetingDuration}
                </span>
              )}
              {externals > 0 && (
                // Worth stating plainly: someone outside the organisation is in
                // the room, and that should never be something you have to infer.
                <span className="flex items-center gap-1 text-warning">
                  <Globe size={12} /> {t("room.header.external", { count: externals })}
                </span>
              )}
              {recording && (
                // Shown to EVERYONE, not only whoever pressed the button. Being
                // recorded is not something anyone should have to work out.
                <span className="flex items-center gap-1 font-medium text-danger">
                  <Circle size={9} className="animate-pulse fill-current" /> {t("room.header.recording")}
                </span>
              )}
              {status === "reconnecting" && <span className="text-warning">{t("room.header.reconnecting")}</span>}
              {status === "connecting" && <span>{t("room.header.connecting")}</span>}
            </div>
          </header>

          {/* Below the header: the video area next to whichever of
              Chat/Notes/Participants is open. Nothing here ever overlays the
              video as a popup — the side panel collapses in place instead. */}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden px-3 pb-3 sm:px-6 sm:pb-6 lg:flex-row">
            {/* min-w-0: becomes a flex-ROW sibling of CallSidePanel at lg:,
                same shrink-below-content-width reason as above. */}
            <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden">
              {/* One provider for the whole video area: the stage, the grid
                  and the filmstrip below all need to share it so a tile can
                  move between them (active speaker, pin, a share starting)
                  without remounting its <video> — see CallTileHost's own
                  doc for why. */}
              <CallTileHostProvider>
              {participants.length === 0 ? (
                <BracketFrame className={cn("glass min-h-0 flex-1", stageUnderSheet)}>
                  <div className="flex h-full items-center justify-center text-sm text-muted">
                    {t("room.stage.connectingPlaceholder")}
                  </div>
                </BracketFrame>
              ) : stage ? (
                // A screen share is wide and wants the row below it; a
                // speaking person's tile wants a companion column beside it.
                // `@container` so the strip can ask how wide the STAGE AREA is —
                // not the window, which the side panel has already taken a share
                // of. The inner box is inset-0 for the same reason BracketFrame's
                // is: it is exactly the space the flex gave this, never more.
                <div className={cn("@container relative min-h-0 flex-1", stageUnderSheet)}>
                  <div className={cn("absolute inset-0 flex gap-3", stage.sharing ? "flex-col" : "flex-col @xl:flex-row")}>
                    <BracketFrame className="glass relative min-h-0 flex-1">
                      {/* Offered only for a pin somebody MADE. The stage following
                          the speaker — or a screen share taking it over, which
                          outranks a pin entirely (see the `sharer` doc comment
                          above `stageId`) — is the room's normal behaviour, and
                          "unpin" over a tile nobody pinned is a control with
                          nothing to undo; it also couldn't move a share off the
                          stage even if it were offered. */}
                      {stage.sharing ? (
                        <span className="pointer-events-none absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
                          <ScreenShare size={12} className="text-accent" />
                          {t("room.stage.presenting")}
                        </span>
                      ) : pinned === stage.identity ? (
                        <UnpinButton name={stage.name} onClick={() => setPinned(null)} />
                      ) : (
                        <span className="pointer-events-none absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
                          <Mic size={12} className="text-accent" />
                          <SpeakingWave className="text-accent" />
                          {t("room.stage.speaking")}
                        </span>
                      )}
                      {/* `active`, not `p.speaking`: whoever is on the stage — by
                          speaking or by a manual pin — gets the highlight for as
                          long as they hold it, not just the instants they're
                          actually making sound. */}
                      <CallTileSlot className="h-full w-full" p={stage} size="stage" active />
                    </BracketFrame>
                    {/* Everyone else, small. Skipped when the stage participant
                        is the only one here: a thumbnail of the same lone face
                        has nothing to add. */}
                    {participants.length > 1 && (
                      <CallSpeakerFilmstrip
                        participants={participants}
                        activeId={stageId}
                        hands={hands}
                        pinned={pinned}
                        onTogglePin={togglePin}
                        orientation={stage.sharing ? "horizontal" : "auto"}
                        limit={stage.sharing ? 4 : 3}
                      />
                    )}
                  </div>
                </div>
              ) : (
                <BracketFrame className={cn("glass min-h-0 flex-1", stageUnderSheet)}>
                  <CallMembers
                    participants={participants}
                    hands={hands}
                    pinned={pinned}
                    onTogglePin={togglePin}
                    layout="grid"
                  />
                </BracketFrame>
              )}
              </CallTileHostProvider>
            </main>

            {/* Chat, Notes, or Participants — one panel, three tabs (see
                CallSidePanel). Stays MOUNTED through the closing transition
                (`panelMounted`) so it can shrink and fade out instead of
                disappearing instantly; once actually closed it's removed from
                the layout altogether, so the video area gets that width back
                rather than a blank column sitting where the panel used to be. */}
            {panelMounted && (
              <CallSidePanel
                active={effectivePanel}
                onSelectTab={setPanel}
                onExport={
                  effectivePanel === "chat"
                    ? exportChat
                    : effectivePanel === "notes"
                      ? exportNotes
                      : undefined
                }
                onClose={() => setPanel(null)}
                unreadChat={unread}
                className={cn(SIDE_PANEL_TRANSITION_BASE, panelEntered ? SIDE_PANEL_OPEN : SIDE_PANEL_CLOSED)}
              >
                {effectivePanel === "chat" ? (
                  <CallChat chat={visibleChat} participants={participants} me={identity} onSend={sendChat} />
                ) : effectivePanel === "notes" ? (
                  <CallNotes notes={notes} onAdd={addNote} />
                ) : (
                  <CallRoster participants={participants} hands={hands} pinned={pinned} onTogglePin={togglePin} />
                )}
              </CallSidePanel>
            )}
          </div>
        </div>

        {/* The sharer's own reminder, and the only stop control that exists.
            A direct child of the shell — not of <main> — because it anchors
            itself to the nearest positioned ancestor (absolute right-0 top-4):
            the shell puts it in the empty right of the header row, where it
            covers nothing. Inside the content region (which is `relative`, for
            the side panel's sheet) it would sit over the stage instead. */}
        {sharing && (
          <ScreenSharePopup
            startedAt={connectedAt}
            onStop={() => void toggleShare()}
            // The header is shorter below `sm` — sit higher, so the popup does
            // not reach down over the stage's own controls.
            className="max-sm:top-1"
          />
        )}

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
