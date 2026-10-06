/**
 * The meeting's entire control surface, as a vertical dock — every action
 * lives here now, instead of split between a header row and a bottom bar.
 * Same handlers as before the redesign (see CallRoom); this only relocates
 * and re-skins them.
 *
 * Grid/Layout (the force-full-grid toggle) is deliberately NOT carried over:
 * the redesign's control list doesn't include it, and there's no natural
 * home for it in a fixed-length vertical dock the way there was in a header
 * cluster. Picture-in-picture, Minimise and the invite link aren't in that
 * list either, but each is a real capability with nothing else offering it,
 * so they're kept as first-class icons below a divider — same gating as
 * always (PiP only where supported, Minimize only where there's a session to
 * minimise into, Copy Link always present but disabled+tooltipped when
 * unavailable). They used to be tucked behind a "More" overflow button
 * (CallMoreMenu); that's gone now, and this is the whole control surface.
 *
 * ── Two shapes, one component ────────────────────────────────────────────────
 * From `sm` (640px) up it is the vertical rail beside the video, a fixed 80px
 * wide. Below that a rail would take a quarter to half of the window's width, so
 * the same buttons become a horizontal dock along the bottom (the room's shell
 * flips to a column — see CallRoom) and scroll sideways when they do not all
 * fit. That is a deliberate second layout rather than the rail being allowed to
 * compress: no button ever shrinks (each is a fixed w-16 that does not flex),
 * and End Call sits outside the scrolling part in both shapes, so leaving is
 * never a scroll away.
 */
import {
  Disc,
  Hand,
  Link2,
  MessageSquare,
  Mic,
  MicOff,
  Minimize2,
  NotebookPen,
  PhoneOff,
  PictureInPicture2,
  ScreenShare,
  UserPlus,
  Users,
  Video,
  VideoOff,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { SidebarButton } from "./SidebarButton";

export function CallSidebar({
  micOn,
  onToggleMic,
  camOn,
  onToggleCam,
  sharing,
  onToggleShare,
  handRaised,
  canRaiseHand,
  onToggleHand,
  participantsActive,
  onToggleParticipants,
  canAddPeople,
  addPeopleTitle,
  onAddPeople,
  canInviteLink,
  inviteLinkTitle,
  mintingInviteLink,
  onCopyInviteLink,
  chatActive,
  unreadChat,
  onToggleChat,
  notesActive,
  onToggleNotes,
  isHost,
  recordingSupported,
  recording,
  onToggleRecording,
  pipSupported,
  pipAvailable,
  pipActive,
  onTogglePip,
  onMinimize,
  onEnd,
}: {
  micOn: boolean;
  onToggleMic: () => void;
  camOn: boolean;
  onToggleCam: () => void;
  sharing: boolean;
  onToggleShare: () => void;
  handRaised: boolean;
  /** False before the room has given us an identity to raise a hand as. */
  canRaiseHand: boolean;
  onToggleHand: () => void;
  participantsActive: boolean;
  onToggleParticipants: () => void;
  canAddPeople: boolean;
  addPeopleTitle: string;
  onAddPeople: () => void;
  canInviteLink: boolean;
  inviteLinkTitle: string;
  mintingInviteLink: boolean;
  onCopyInviteLink: () => void;
  chatActive: boolean;
  unreadChat: number;
  onToggleChat: () => void;
  notesActive: boolean;
  onToggleNotes: () => void;
  isHost: boolean;
  recordingSupported: boolean;
  recording: boolean;
  onToggleRecording: () => void;
  pipSupported: boolean;
  /** Supported AND there is a video to float, or PiP is already up. */
  pipAvailable: boolean;
  pipActive: boolean;
  onTogglePip: () => void;
  onMinimize?: () => void;
  onEnd: () => void;
}) {
  const { t } = useTranslation("calls");
  return (
    <nav
      aria-label={t("sidebar.controlsAriaLabel")}
      className="glass relative z-20 flex w-full shrink-0 flex-row overflow-hidden rounded-t-2xl sm:h-full sm:min-h-0 sm:w-20 sm:flex-col sm:rounded-r-3xl sm:rounded-t-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 items-center overflow-x-auto overscroll-contain px-2 py-1 [scrollbar-color:var(--color-border)_transparent] [scrollbar-width:thin] sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto sm:px-0 sm:py-4">
        <SidebarButton
          icon={micOn ? <Mic size={20} /> : <MicOff size={20} />}
          label={micOn ? t("sidebar.mute") : t("sidebar.muted")}
          onClick={onToggleMic}
          active={!micOn}
          activeClassName="text-danger ring-1 ring-danger/50"
        />
        <SidebarButton
          icon={camOn ? <Video size={20} /> : <VideoOff size={20} />}
          label={t("sidebar.camera")}
          onClick={onToggleCam}
          active={!camOn}
          activeClassName="text-danger ring-1 ring-danger/50"
        />
        <SidebarButton icon={<ScreenShare size={20} />} label={t("sidebar.share")} onClick={onToggleShare} active={sharing} />
        <SidebarButton
          icon={<Hand size={20} />}
          label={t("sidebar.raise")}
          onClick={onToggleHand}
          active={handRaised}
          disabled={!canRaiseHand}
          activeClassName="bg-warning/15 text-warning ring-1 ring-warning [filter:drop-shadow(0_0_6px_var(--color-warning))]"
        />
        <SidebarButton icon={<Users size={20} />} label={t("sidebar.people")} onClick={onToggleParticipants} active={participantsActive} />
        <SidebarButton
          icon={<UserPlus size={20} />}
          label={t("sidebar.add")}
          onClick={onAddPeople}
          disabled={!canAddPeople}
          title={canAddPeople ? t("sidebar.addPeople") : addPeopleTitle}
        />
        <SidebarButton icon={<MessageSquare size={20} />} label={t("sidebar.chats")} onClick={onToggleChat} active={chatActive} badge={unreadChat} />
        <SidebarButton icon={<NotebookPen size={20} />} label={t("sidebar.notes")} onClick={onToggleNotes} active={notesActive} />
        {isHost && (
          <SidebarButton
            icon={<Disc size={20} className={recording ? "fill-current" : undefined} />}
            label={t("sidebar.record")}
            onClick={onToggleRecording}
            active={recording}
            disabled={!recordingSupported}
            title={recordingSupported ? undefined : t("sidebar.recordUnsupported")}
            activeClassName="bg-danger/15 text-danger ring-1 ring-danger [filter:drop-shadow(0_0_6px_var(--color-danger))]"
          />
        )}
        <div className="mx-1 h-8 w-px shrink-0 bg-border/70 sm:mx-0 sm:my-1 sm:h-px sm:w-8" />
        <SidebarButton
          icon={<Link2 size={20} />}
          label={t("sidebar.copyLink")}
          onClick={onCopyInviteLink}
          disabled={!canInviteLink || mintingInviteLink}
          title={canInviteLink ? t("sidebar.copyInviteLink") : inviteLinkTitle}
        />
        {pipSupported && (
          <SidebarButton
            icon={<PictureInPicture2 size={20} />}
            label={pipActive ? t("sidebar.exitPip") : t("sidebar.pip")}
            onClick={onTogglePip}
            active={pipActive}
            disabled={!pipAvailable}
            title={
              pipActive
                ? t("sidebar.exitPictureInPicture")
                : pipAvailable
                  ? t("sidebar.pictureInPicture")
                  : t("sidebar.pictureInPictureNoVideo")
            }
          />
        )}
        {onMinimize && (
          <SidebarButton icon={<Minimize2 size={20} />} label={t("sidebar.minimize")} onClick={onMinimize} title={t("sidebar.minimise")} />
        )}
      </div>
      <div className="flex shrink-0 items-center justify-center border-l border-border/70 px-2 sm:border-l-0 sm:border-t sm:px-0 sm:py-3">
        <SidebarButton
          icon={<PhoneOff size={20} />}
          label={t("sidebar.end")}
          onClick={onEnd}
          title={t("sidebar.endCall")}
          className="bg-danger text-white hover:bg-danger hover:brightness-90 hover:text-white"
        />
      </div>
    </nav>
  );
}
