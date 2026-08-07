import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Phone, PhoneOff, Mic, MicOff, Video, VideoOff } from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@taskboard/ui";
import { useCall } from "../lib/useCall";

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
}: {
  stream?: MediaStream;
  muted?: boolean;
  className?: string;
  onBlocked?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useAttachedStream(ref, stream, onBlocked);
  return <video ref={ref} autoPlay playsInline muted={muted} className={className} />;
}

/** The remote voice on an audio-only call.
 *
 *  A real <audio> element rather than the hidden <video> this used to be: a
 *  `display:none` video is an element whose playback behaviour varies by
 *  browser, and there is no reason to make the one thing the whole call exists
 *  for depend on that. */
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
    green: "bg-emerald-500 hover:bg-emerald-600 text-white",
    red: "bg-red-500 hover:bg-red-600 text-white",
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

/** Global call overlay — incoming ring, outgoing/connecting, and in-call. Mounted
 *  once under CallProvider in AppShell; renders nothing when idle. */
export function CallUI() {
  const call = useCall();
  if (call.status === "idle") return null;

  const peer = call.peerName ?? "User";
  const isVideo = call.media === "video";

  // A call that connects and then plays nothing looks like the network broke.
  // Name the real cause instead, and say what to do about it — any click then
  // retries playback (see useAttachedStream).
  const onAudioBlocked = () =>
    toast("Tap to hear the call", { description: "Your browser blocked audio playback until you interact." });

  if (call.status === "incoming") {
    return (
      <Backdrop>
        <div className="flex flex-col items-center gap-5 rounded-3xl bg-surface/95 px-10 py-8 shadow-2xl ring-1 ring-border">
          <Avatar name={peer} size="lg" />
          <div className="text-center">
            <div className="text-lg font-semibold text-fg">{peer}</div>
            <div className="text-sm text-muted">Incoming {isVideo ? "video" : "voice"} call…</div>
          </div>
          <div className="flex gap-8">
            <RoundButton tone="red" title="Decline" onClick={call.decline}>
              <PhoneOff size={22} />
            </RoundButton>
            <RoundButton tone="green" title="Accept" onClick={call.accept}>
              <Phone size={22} />
            </RoundButton>
          </div>
        </div>
      </Backdrop>
    );
  }

  const subtitle =
    call.status === "in-call"
      ? "Connected"
      : call.status === "ended"
        ? (call.endedReason ?? "Call ended")
        : "Calling…";

  return (
    <Backdrop dark={isVideo}>
      <div className="relative flex h-full max-h-[90vh] w-full max-w-3xl flex-col items-center justify-center gap-6 rounded-3xl bg-black/80 p-6">
        {isVideo ? (
          <StreamVideo
            stream={call.remoteStream}
            className="absolute inset-0 h-full w-full rounded-3xl object-cover"
            onBlocked={onAudioBlocked}
          />
        ) : (
          <>
            <Avatar name={peer} size="lg" />
            <RemoteAudio stream={call.remoteStream} onBlocked={onAudioBlocked} />
          </>
        )}
        {isVideo && call.localStream && (
          <StreamVideo
            stream={call.localStream}
            muted
            className="absolute bottom-24 right-4 z-10 h-36 w-28 rounded-xl object-cover ring-2 ring-white/30"
          />
        )}

        <div className="z-10 mt-auto text-center text-white drop-shadow">
          <div className="text-xl font-semibold">{peer}</div>
          <div className="text-sm opacity-80">{subtitle}</div>
        </div>

        <div className="z-10 mb-2 flex gap-5">
          <RoundButton title={call.micOn ? "Mute" : "Unmute"} onClick={call.toggleMic}>
            {call.micOn ? <Mic size={20} /> : <MicOff size={20} />}
          </RoundButton>
          {isVideo && (
            <RoundButton title={call.camOn ? "Stop video" : "Start video"} onClick={call.toggleCam}>
              {call.camOn ? <Video size={20} /> : <VideoOff size={20} />}
            </RoundButton>
          )}
          <RoundButton tone="red" title="Hang up" onClick={call.hangup}>
            <PhoneOff size={20} />
          </RoundButton>
        </div>
      </div>
    </Backdrop>
  );
}
