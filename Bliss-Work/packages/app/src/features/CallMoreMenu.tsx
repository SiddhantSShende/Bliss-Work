/**
 * The overflow for controls that don't earn a permanent seat in the primary
 * row: adding people, recording, picture-in-picture, minimising. Each is
 * already gated by its own condition exactly as it was inline before this
 * moved them here (host-only recording, PiP only where supported, minimise
 * only where there's a session to minimise into) — this only relocates them,
 * it doesn't change when they're offered.
 *
 * Two instances exist on screen at once (the top-right cluster and the
 * bottom bar both have a More button), each with its own open/close state —
 * see CallRoom. `placement` is the only thing that differs between them: the
 * bottom one has to open upward, or the panel would render off the bottom of
 * the window.
 */
import { useState } from "react";
import { Circle, Minimize2, MoreHorizontal, PictureInPicture2, UserPlus } from "lucide-react";
import { cn } from "@taskboard/ui";
import { usePopupDismiss } from "../lib/usePopupDismiss";
import { CallControlButton } from "./CallControls";

export function CallMoreMenu({
  placement,
  canAddPeople,
  addPeopleTitle,
  onAddPeople,
  isHost,
  recordingSupported,
  recording,
  onToggleRecording,
  pipSupported,
  pipActive,
  onTogglePip,
  onMinimize,
}: {
  /** Which side of the trigger the panel opens toward. */
  placement: "up" | "down";
  canAddPeople: boolean;
  addPeopleTitle: string;
  onAddPeople: () => void;
  isHost: boolean;
  recordingSupported: boolean;
  recording: boolean;
  onToggleRecording: () => void;
  pipSupported: boolean;
  pipActive: boolean;
  onTogglePip: () => void;
  /** Omitted where there's nowhere to minimise into — the row this whole
   *  menu started as also gated it this way. */
  onMinimize?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = usePopupDismiss<HTMLDivElement>(open, () => setOpen(false));

  /** Every row closes the menu first — each one either opens a dialog or
   *  fires an action, and none of them wants the panel left behind. */
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };

  return (
    <div ref={wrap} className="relative">
      <CallControlButton
        variant="surface"
        title="More"
        pressed={open}
        onClick={() => setOpen((v) => !v)}
        className={open ? "bg-accent text-accent-fg" : undefined}
      >
        <MoreHorizontal size={17} />
      </CallControlButton>
      {open && (
        <div
          role="menu"
          aria-label="More call options"
          className={cn(
            "absolute right-0 z-50 w-56 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-card",
            placement === "up" ? "bottom-full mb-1.5" : "top-full mt-1.5",
          )}
        >
          <MenuItem
            icon={<UserPlus size={15} />}
            label="Add people"
            disabled={!canAddPeople}
            title={canAddPeople ? undefined : addPeopleTitle}
            onClick={pick(onAddPeople)}
          />
          {isHost && (
            <MenuItem
              icon={<Circle size={15} className={recording ? "fill-current text-danger" : undefined} />}
              label={recording ? "Stop recording" : "Record meeting"}
              disabled={!recordingSupported}
              title={recordingSupported ? undefined : "This browser can't record meetings"}
              onClick={pick(onToggleRecording)}
            />
          )}
          {pipSupported && (
            <MenuItem
              icon={<PictureInPicture2 size={15} />}
              label={pipActive ? "Exit picture-in-picture" : "Picture-in-picture"}
              onClick={pick(onTogglePip)}
            />
          )}
          {onMinimize && (
            <MenuItem icon={<Minimize2 size={15} />} label="Minimise" onClick={pick(onMinimize)} />
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-fg transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="shrink-0 text-muted">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
