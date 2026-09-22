import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { Phone, PhoneOff } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Avatar } from "@taskboard/ui";
import { useCall } from "../lib/useCall";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { CallControls } from "./CallControls";
import { ScreenSharePopup } from "./ScreenSharePopup";
import { AddPeopleDialog } from "./AddPeopleDialog";
import { useMeetingSession } from "../lib/MeetingSession";

/** Attaches a MediaStream to a media element and STARTS it.
 *
 *  srcObject can't be set via JSX, and the `autoplay` attribute is not enough on
 *  its own: playing UNMUTED media is refused unless the document has recent user
 *  activation, and the refusal is silent — which presents as a call that reaches
 *  "Connected" and then plays nothing at all. Calling play() explicitly gives us
 *  a promise, so a refusal becomes something we can tell the user about instead
 *  of a mystery. */
function useAttachedStream(
  ref: RefObject<HTMLMediaElement | null>,
  stream: MediaStream | undefined,
  onBlocked?: () => void,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== (stream ?? null)) el.srcObject = stream ?? null;
    if (!stream) return;

    // If it is refused, retry on the user's very next interaction — one click
    // anywhere is enough, and the toast onBlocked raises tells them so.
    const gestures = ["pointerdown", "keydown", "touchstart"] as const;
    const retry = () => {
      void el.play().catch(() => {});
      off();
    };
    const off = () => gestures.forEach((g) => window.removeEventListener(g, retry));

    const started = el.play();
    if (started && typeof started.then === "function") {
      started.catch(() => {
        onBlocked?.();
        gestures.forEach((g) => window.addEventListener(g, retry, { passive: true }));
      });
    }
    return off;
  }, [ref, stream, onBlocked]);
}

function StreamVideo({
  stream,
  muted,
  className,
  onBlocked,
  onPlaying,
}: {
  stream?: MediaStream;
  muted?: boolean;
  className?: string;
  onBlocked?: () => void;
  /** The element actually decoded and painted a frame. The offerer's copy of a
   *  remote video track is negotiated the same way the answerer's is, but its
   *  `mute`/`unmute` events are the one thing that differs by role — they ride
   *  RTCRtpReceiver bookkeeping that is, in practice, not something both roles
   *  fire identically for a transceiver that was created (via addTransceiver)
   *  before the description that finished negotiating it, which is the
   *  offerer's own situation here (see CallSession's class doc). `onPlaying`
   *  is the decoder itself, not that bookkeeping, so it is true regardless of
   *  whether `unmute` ever arrives. */
  onPlaying?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useAttachedStream(ref, stream, onBlocked);
  return (
    <video ref={ref} autoPlay playsInline muted={muted} className={className} onPlaying={onPlaying} />
  );
}

/** The remote voice, on every call.
 *
 *  A real <audio> element rather than the hidden <video> this used to be: a
 *  `display:none` video is an element whose playback behaviour varies by
 *  browser, and there is no reason to make the one thing the whole call exists
 *  for depend on that.
 *
 *  Rendered whether or not there is a picture, and the picture element is muted,
 *  so the voice is never interrupted by the camera going on or off mid-call. */
function RemoteAudio({ stream, onBlocked }: { stream?: MediaStream; onBlocked?: () => void }) {
  const ref = useRef<HTMLAudioElement>(null);
  useAttachedStream(ref, stream, onBlocked);
  return <audio ref={ref} autoPlay />;
}

function RoundButton({
  onClick,
  title,
  tone = "neutral",
  children,
}: {
  onClick: () => void;
  title: string;
  tone?: "neutral" | "green" | "red";
  children: ReactNode;
}) {
  const tones = {
    neutral: "bg-white/15 hover:bg-white/25 text-white",
    green: "bg-success hover:brightness-90 text-white",
    red: "bg-danger hover:brightness-90 text-white",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`flex h-14 w-14 items-center justify-center rounded-full shadow-lg transition ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

function Backdrop({ children, dark }: { children: ReactNode; dark?: boolean }) {
  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center ${dark ? "bg-black/70" : "bg-black/40"} backdrop-blur-sm`}
    >
      {children}
    </div>
  );
}

/**
 * Where a 1:1 call goes once somebody adds a third person.
 *
 * The peer connection is already closed by this point — CallProvider closes it
 * as it hands over — so all this has to do is fetch the call row the room is
 * keyed on and give it to CallRoom, which is the same surface channel calls and
 * meetings use.
 */
function RoomHandoff({ callId, onClose }: { callId: string; onClose: () => void }) {
  const { t } = useTranslation("callRoom");
  const { api } = useRuntime();
  const { enter, call: active } = useMeetingSession();
  const { data: call, isError } = useQuery({
    queryKey: qk.call(callId),
    queryFn: () => api.call(callId),
  });

  useEffect(() => {
    if (!isError) return;
    toast.error(t("callUi.couldNotOpenRoom"));
    onClose();
  }, [isError, onClose, t]);

  // Handed to the session above the router rather than rendered here, so the
  // widened call gets exactly what every other meeting gets: it survives
  // navigation, and it can be minimised. This overlay used to box the room into
  // a modal, which meant a 1:1 that grew a third person took the whole app
  // hostage until somebody hung up.
  useEffect(() => {
    if (!call || active?.id === call.id) return;
    enter(call, onClose);
  }, [call, active?.id, enter, onClose]);

  if (call) return null;

  return (
    <Backdrop dark>
      <div className="flex h-full items-center justify-center text-sm text-muted">
        {t("callUi.movingToRoom")}
      </div>
    </Backdrop>
  );
}

/** Global call overlay — incoming ring, outgoing/connecting, and in-call. Mounted
 *  once under CallProvider in AppShell; renders nothing when idle. */
export function CallUI() {
  const { t } = useTranslation("callRoom");
  const call = useCall();
  const [addOpen, setAddOpen] = useState(false);

  // A call that is over has nothing to add anyone to.
  useEffect(() => {
    if (call.status === "idle") setAddOpen(false);
  }, [call.status]);

  // A call that connects and then plays nothing looks like the network broke.
  // Name the real cause instead, and say what to do about it — any click then
  // retries playback (see useAttachedStream).
  //
  // STABLE, deliberately: it is a dependency of the effect that binds the media
  // elements, so a fresh closure on every render made that effect tear down its
  // gesture listeners and re-call play() each time this overlay re-rendered —
  // which is every peer state change, mid-call.
  const onAudioBlocked = useCallback(
    () =>
      toast(t("callUi.audioBlocked.title"), {
        description: t("callUi.audioBlocked.description"),
      }),
    [t],
  );

  // Backstop for `remoteVideo`/`peerCamOn`: both are told to us (a track's
  // mute/unmute events, a message on the metadata channel) rather than
  // observed directly, and the offerer's copy of the incoming video track can
  // go the whole call without ever firing `unmute` even while frames are
  // actually arriving — see StreamVideo's onPlaying doc. The element itself
  // painting a frame is the one signal that cannot lie either way, so it
  // joins the OR below rather than replacing what's already there: the
  // existing signals are faster (no frame has to decode first) and still
  // right for the ordinary "peer's camera is off" case.
  //
  // Reset on every new remoteStream (a fresh CallSession per call, or none
  // between calls) — this is a persistent singleton overlay, not remounted
  // per call, so nothing else would clear a stale "seen" from a previous one.
  const [remoteFrameSeen, setRemoteFrameSeen] = useState(false);
  useEffect(() => {
    setRemoteFrameSeen(false);
  }, [call.remoteStream]);

  if (call.status === "idle") return null;

  const peer = call.peerName ?? t("callUi.peerFallbackName");
  const isVideo = call.media === "video";

  // Widened past two people: the room owns the media now.
  if (call.roomCallId) return <RoomHandoff callId={call.roomCallId} onClose={call.hangup} />;

  if (call.status === "incoming") {
    return (
      <Backdrop>
        <div className="flex flex-col items-center gap-5 rounded-3xl bg-surface/95 px-10 py-8 shadow-2xl ring-1 ring-border">
          <Avatar name={peer} size="lg" />
          <div className="text-center">
            <div className="text-lg font-semibold text-fg">{peer}</div>
            <div className="text-sm text-muted">
              {isVideo ? t("callUi.incomingVideo") : t("callUi.incomingVoice")}
            </div>
          </div>
          <div className="flex gap-8">
            <RoundButton tone="red" title={t("callUi.decline")} onClick={call.decline}>
              <PhoneOff size={22} />
            </RoundButton>
            <RoundButton tone="green" title={t("callUi.accept")} onClick={call.accept}>
              <Phone size={22} />
            </RoundButton>
          </div>
        </div>
      </Backdrop>
    );
  }

  const subtitle =
    call.status === "in-call"
      ? call.peerSharing
        ? t("callUi.subtitle.sharing", { peer })
        : t("callUi.subtitle.connected")
      : call.status === "ended"
        ? (call.endedReason ?? t("callUi.subtitle.callEnded"))
        : t("callUi.subtitle.calling");

  // What we send back: the screen while we are sharing one, the camera
  // otherwise. Both are muted locally — an unmuted local preview is an echo.
  const selfView = call.sharing ? call.screenStream : call.camOn ? call.localStream : undefined;
  // Three independent signals, deliberately OR'd. `remoteVideo` is delivery — the
  // track stopped being muted, so pictures are actually arriving. The peer's own
  // flags are intent, told to us over the metadata channel. `remoteFrameSeen` is
  // the video element itself having painted a frame — see its own doc for why
  // it, alone of the three, cannot be late in a way that never resolves. Any one
  // alone can be late (a browser that is slow to fire `unmute`, a channel
  // message that has not landed yet), and the cost of believing one too early is
  // a black frame for a moment, against a call that never shows a picture at all.
  const remoteVisible = call.remoteVideo || call.peerCamOn || call.peerSharing || remoteFrameSeen;
  const showingVideo = remoteVisible || !!selfView;

  return (
    <Backdrop dark={showingVideo}>
      {/* dvh, not vh: on a browser with a dynamic toolbar (mobile, some
          desktop PWA chrome) vh can overshoot the actually-visible area,
          clipping the bottom of the card — the same fix CallRoom's pre-join
          preview already applies to its own height cap. */}
      <div className="relative flex h-full max-h-[90dvh] w-full max-w-3xl flex-col items-center justify-center gap-6 rounded-3xl bg-black/80 p-6">
        {/* The voice, always — never on the <video>, which is muted, so the
            sound does not cut out when a camera or a share starts. */}
        <RemoteAudio stream={call.remoteStream} onBlocked={onAudioBlocked} />
        {/* Always attached, like RemoteAudio above — not mounted only once
            `remoteVisible` says so. It used to be the other way round, which
            meant nothing was even bound to the stream (so nothing could ever
            decode a frame) until a signal that is itself sometimes late or
            missing said to start. Absolutely positioned, so it never
            participates in this flex column's layout; the Avatar below still
            centers itself exactly as before, just now painted OVER a video
            that is already live underneath it rather than in its place. */}
        <StreamVideo
          stream={call.remoteStream}
          muted
          className="absolute inset-0 h-full w-full rounded-3xl object-cover"
          onPlaying={() => setRemoteFrameSeen(true)}
        />
        {!remoteVisible && <Avatar name={peer} size="lg" />}
        {selfView && (
          <StreamVideo
            stream={selfView}
            muted
            // Mirrored only while this is the camera: once `call.sharing` swaps
            // `selfView` to the screen stream (see its definition above), the
            // viewer's own display must come through un-flipped and readable.
            className={`absolute bottom-24 right-4 z-10 h-36 w-28 rounded-xl object-cover ring-2 ring-white/30 ${call.sharing ? "" : "-scale-x-100"}`}
          />
        )}

        {call.sharing && <ScreenSharePopup startedAt={call.connectedAt} onStop={call.toggleShare} />}

        <div className="z-10 mt-auto text-center text-white drop-shadow">
          <div className="text-xl font-semibold">{peer}</div>
          <div className="text-sm opacity-80">{subtitle}</div>
        </div>

        <div className="z-10 mb-2">
          <CallControls
            micOn={call.micOn}
            camOn={call.camOn}
            sharing={call.sharing}
            startedAt={call.connectedAt}
            // Adding someone needs the call row the ring is backed by, and a
            // live peer connection to carry the "we are moving to the room"
            // message to the other end.
            canAddPeople={call.status === "in-call" && !!call.recordId}
            onAddPeople={() => setAddOpen(true)}
            onToggleShare={call.toggleShare}
            onToggleMic={call.toggleMic}
            onToggleCam={call.toggleCam}
            onEnd={call.hangup}
          />
        </div>
      </div>

      {/* Its own stacking context, above this overlay's z-[100]: Modal pins
          itself at z-50, which would otherwise put the picker behind the call. */}
      <div className="relative z-[120]">
        <AddPeopleDialog
          open={addOpen}
          onClose={() => setAddOpen(false)}
          exclude={new Set(call.peerId ? [call.peerId] : [])}
          onAdd={call.addPeople}
        />
      </div>
    </Backdrop>
  );
}
