import { useEffect, useRef, type ReactNode } from "react";
import { Phone, PhoneOff, Mic, MicOff, Video, VideoOff } from "lucide-react";
import { Avatar } from "@taskboard/ui";
import { useCall } from "../lib/useCall";

/** Binds a MediaStream to a <video> element (srcObject can't be set via JSX). */
function StreamVideo({ stream, muted, className }: { stream?: MediaStream; muted?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== (stream ?? null)) el.srcObject = stream ?? null;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} className={className} />;
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
          <StreamVideo stream={call.remoteStream} className="absolute inset-0 h-full w-full rounded-3xl object-cover" />
        ) : (
          <>
            <Avatar name={peer} size="lg" />
            {/* Audio-only: hidden <video> still plays the remote audio track. */}
            <StreamVideo stream={call.remoteStream} className="hidden" />
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
