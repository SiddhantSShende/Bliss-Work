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
  pipActive: boolean;
  onTogglePip: () => void;
  onMinimize?: () => void;
  onEnd: () => void;
}) {
  const { t } = useTranslation("calls");
  return (
    <nav
      aria-label={t("sidebar.controlsAriaLabel")}
      className="glass relative z-20 flex min-h-0 w-20 shrink-0 flex-col items-center gap-1 overflow-y-auto overscroll-contain rounded-r-3xl py-4 [scrollbar-color:var(--color-border)_transparent] [scrollbar-width:thin]"
    >
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
      <SidebarButton
        icon={<ScreenShare size={20} />}
        label={t("sidebar.share")}
        onClick={onToggleShare}
        active={sharing}
      />
      <SidebarButton
        icon={<Hand size={20} />}
        label={t("sidebar.raise")}
        onClick={onToggleHand}
        active={handRaised}
        disabled={!canRaiseHand}
        activeClassName="bg-warning/15 text-warning ring-1 ring-warning [filter:drop-shadow(0_0_6px_var(--color-warning))]"
      />
      <SidebarButton
        icon={<Users size={20} />}
        label={t("sidebar.people")}
        onClick={onToggleParticipants}
        active={participantsActive}
      />
      <SidebarButton
        icon={<UserPlus size={20} />}
        label={t("sidebar.add")}
        onClick={onAddPeople}
        disabled={!canAddPeople}
        title={canAddPeople ? t("sidebar.addPeople") : addPeopleTitle}
      />
      {/* Chats — the reference design's example of the active treatment every
          toggle above and below also uses: a cyan glow, not a one-off. */}
      <SidebarButton
        icon={<MessageSquare size={20} />}
        label={t("sidebar.chats")}
        onClick={onToggleChat}
        active={chatActive}
        badge={unreadChat}
      />
      <SidebarButton
        icon={<NotebookPen size={20} />}
        label={t("sidebar.notes")}
        onClick={onToggleNotes}
        active={notesActive}
      />
      {/* Host-only, and hidden rather than disabled for everyone else — the
       ` server would answer everyone else's click with 403 anyway. */}
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

      <div className="my-1 h-px w-8 shrink-0 bg-border/70" />

      {/* Formerly collapsed behind a "More" overflow button (CallMoreMenu,
          removed). Same handlers, same gating (PiP only where supported,
          Minimize only where there's a session to minimise into, Copy Link
          always present but disabled with a tooltip when unavailable) — just
          first-class icons now instead of a popover. */}
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
          title={pipActive ? t("sidebar.exitPictureInPicture") : t("sidebar.pictureInPicture")}
        />
      )}
      {onMinimize && (
        <SidebarButton
          icon={<Minimize2 size={20} />}
          label={t("sidebar.minimize")}
          onClick={onMinimize}
          title={t("sidebar.minimise")}
        />
      )}

      <div className="mt-auto pt-2">
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
