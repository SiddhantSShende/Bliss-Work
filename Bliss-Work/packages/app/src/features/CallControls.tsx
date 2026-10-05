import type { ReactNode } from "react";
import { Mic, MicOff, PhoneOff, ScreenShare, UserPlus, Video, VideoOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@taskboard/ui";
import { useCallDuration } from "../lib/callTimer";

/**
 * The in-call controls. FIVE, everywhere a call is on screen:
 *
 *   Add People · Share Screen · Mute · Video · End Call
 *
 * Icons only, and the same five whether the call is voice or video and whether
 * it is running peer-to-peer (CallUI) or through the room (CallRoom). "Video"
 * is offered on a voice call too — turning the camera on mid-call is a real
 * thing to want, and the media session reserves a video slot up front precisely
 * so it can be answered without renegotiating.
 *
 * A control that cannot do anything right now is DISABLED rather than removed,
 * so the row does not change shape underneath a moving cursor and the fifth
 * button is always in the same place.
 */

type Variant = "overlay" | "surface";

/** The two grounds these buttons sit on: the dark in-call overlay, and an
 *  ordinary themed surface (the room's footer). Nothing here introduces a
 *  colour — the overlay set is the one CallUI already used. */
const SKIN: Record<Variant, { idle: string; off: string; size: string; icon: number }> = {
  overlay: {
    idle: "bg-white/15 hover:bg-white/25 text-white",
    off: "bg-white text-slate-900 hover:bg-white/90",
    size: "h-14 w-14",
    icon: 20,
  },
  surface: {
    idle: "bg-surface-2 text-fg hover:bg-border/60",
    off: "bg-fg text-surface hover:opacity-90",
    size: "h-11 w-11",
    icon: 17,
  },
};

function Control({
  title,
  onClick,
  disabled,
  pressed,
  className,
  variant,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  /** Toggle state, for buttons that have one. */
  pressed?: boolean;
  className?: string;
  variant: Variant;
  children: ReactNode;
}) {
  const skin = SKIN[variant];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full shadow-lg transition disabled:cursor-not-allowed disabled:opacity-40",
        skin.size,
        skin.idle,
        className,
      )}
    >
      {children}
    </button>
  );
}

export function CallControls({
  micOn,
  camOn,
  sharing,
  startedAt,
  canAddPeople = true,
  addPeopleTitle,
  addingPeople = false,
  variant = "overlay",
  className,
  onAddPeople,
  onToggleShare,
  onToggleMic,
  onToggleCam,
  onEnd,
}: {
  micOn: boolean;
  camOn: boolean;
  /** WE are sharing. The share control turns red and grows a call timer. */
  sharing: boolean;
  /** When the call connected, for that timer. */
  startedAt?: number;
  /** False while the call has nothing to add people to — before it connects,
   *  or when the server never gave it a call row. */
  canAddPeople?: boolean;
  /** Why, when it is disabled — a disabled control that does not say why it is
   *  disabled is just a broken one. */
  addPeopleTitle?: string;
  addingPeople?: boolean;
  variant?: Variant;
  /** For a surface that needs the row to behave differently — the room lets it
   *  wrap, because nine controls do not fit one line on a phone. */
  className?: string;
  /** Omitted where Add People lives somewhere else on the surface (CallRoom
   *  folds it into its "More" menu instead) — gated like Composer's
   *  attachment button, so a surface that doesn't wire it never shows a
   *  control that does nothing. */
  onAddPeople?: () => void;
  onToggleShare: () => void;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onEnd: () => void;
}) {
  const { t } = useTranslation("callRoom");
  const skin = SKIN[variant];
  // Only while sharing, because that is the only state that renders it. Passed
  // as undefined otherwise so the hook tears its interval down: this row is
  // mounted for the whole call, and ticking it once a second to compute a
  // string nothing displays re-rendered five buttons every second of every
  // call. The panel keeps its own copy of the same clock for the same reason.
  const duration = useCallDuration(sharing ? startedAt : undefined);

  return (
    <div className={cn("z-10 flex items-center justify-center gap-3 sm:gap-4", className)}>
      {onAddPeople && (
        <Control
          variant={variant}
          title={addPeopleTitle ?? t("controls.addPeopleDefault")}
          onClick={onAddPeople}
          disabled={!canAddPeople || addingPeople}
        >
          <UserPlus size={skin.icon} />
        </Control>
      )}

      {/* Sharing is the one state worth shouting about, so this control stops
          being an icon in a row and becomes a red, ticking indicator. */}
      <Control
        variant={variant}
        title={sharing ? t("controls.stopSharing") : t("controls.startSharing")}
        pressed={sharing}
        onClick={onToggleShare}
        className={cn(
          sharing &&
            "w-auto gap-2 bg-danger/15 px-4 text-danger ring-2 ring-danger hover:bg-danger/25",
        )}
      >
        <ScreenShare size={skin.icon} />
        {sharing && (
          <span className="text-sm font-semibold tabular-nums" aria-label={t("controls.callDurationAriaLabel")}>
            {duration}
          </span>
        )}
      </Control>

      <Control
        variant={variant}
        title={micOn ? t("controls.mute") : t("controls.unmute")}
        pressed={!micOn}
        onClick={onToggleMic}
        className={cn(!micOn && skin.off)}
      >
        {micOn ? <Mic size={skin.icon} /> : <MicOff size={skin.icon} />}
      </Control>

      <Control
        variant={variant}
        title={camOn ? t("controls.cameraOff") : t("controls.cameraOn")}
        pressed={camOn}
        onClick={onToggleCam}
        className={cn(!camOn && skin.off)}
      >
        {camOn ? <Video size={skin.icon} /> : <VideoOff size={skin.icon} />}
      </Control>

      <Control
        variant={variant}
        title={t("controls.endCall")}
        onClick={onEnd}
        className="bg-danger text-white hover:brightness-90"
      >
        <PhoneOff size={skin.icon} />
      </Control>
    </div>
  );
}
