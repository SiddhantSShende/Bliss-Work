/**
 * The meeting's entire control surface, as a vertical dock — every action
 * lives here now, instead of split between a header row and a bottom bar.
 * Same handlers as before the redesign (see CallRoom); this only relocates
 * and re-skins them.
 *
 * Grid/Layout (the force-full-grid toggle) is deliberately NOT carried over:
 * the redesign's control list doesn't include it, and there's no natural
 * home for it in a fixed-length vertical dock the way there was in a header
 * cluster. Picture-in-picture and Minimise aren't in that list either, but
 * both are real capabilities (keep the call running while you do something
 * else) with nothing else offering them, so they're kept — tucked into a
 * small "More" menu at the bottom rather than given two more first-class
 * icons the reference design didn't ask for.
 */
import {
  Disc,
  Hand,
  Link2,
  MessageSquare,
  Mic,
  MicOff,
  NotebookPen,
  PhoneOff,
  ScreenShare,
  UserPlus,
  Users,
  Video,
  VideoOff,
} from "lucide-react";
import { CallMoreMenu } from "./CallMoreMenu";
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
  return (
    <nav
      aria-label="Meeting controls"
      className="glass relative z-20 flex w-20 shrink-0 flex-col items-center gap-1 overflow-y-auto rounded-r-3xl py-4"
    >
      <SidebarButton
        icon={micOn ? <Mic size={20} /> : <MicOff size={20} />}
        label={micOn ? "Mute" : "Muted"}
        onClick={onToggleMic}
        active={!micOn}
        activeClassName="text-danger ring-1 ring-danger/50"
      />
      <SidebarButton
        icon={camOn ? <Video size={20} /> : <VideoOff size={20} />}
        label="Camera"
        onClick={onToggleCam}
        active={!camOn}
        activeClassName="text-danger ring-1 ring-danger/50"
      />
      <SidebarButton
        icon={<ScreenShare size={20} />}
        label="Share"
        onClick={onToggleShare}
        active={sharing}
      />
      <SidebarButton
        icon={<Hand size={20} />}
        label="Raise"
        onClick={onToggleHand}
        active={handRaised}
        disabled={!canRaiseHand}
        activeClassName="bg-warning/15 text-warning ring-1 ring-warning [filter:drop-shadow(0_0_6px_var(--color-warning))]"
      />
      <SidebarButton
        icon={<Users size={20} />}
        label="People"
        onClick={onToggleParticipants}
        active={participantsActive}
      />
      <SidebarButton
        icon={<UserPlus size={20} />}
        label="Add"
        onClick={onAddPeople}
        disabled={!canAddPeople}
        title={canAddPeople ? "Add people" : addPeopleTitle}
      />
      <SidebarButton
        icon={<Link2 size={20} />}
        label="Invite"
        onClick={onCopyInviteLink}
        disabled={!canInviteLink || mintingInviteLink}
        title={canInviteLink ? "Copy invite link" : inviteLinkTitle}
      />
      {/* Chats — the reference design's example of the active treatment every
          toggle above and below also uses: a cyan glow, not a one-off. */}
      <SidebarButton
        icon={<MessageSquare size={20} />}
        label="Chats"
        onClick={onToggleChat}
        active={chatActive}
        badge={unreadChat}
      />
      <SidebarButton
        icon={<NotebookPen size={20} />}
        label="Notes"
        onClick={onToggleNotes}
        active={notesActive}
      />
      {/* Host-only, and hidden rather than disabled for everyone else — the
       ` server would answer everyone else's click with 403 anyway. */}
      {isHost && (
        <SidebarButton
          icon={<Disc size={20} className={recording ? "fill-current" : undefined} />}
          label="Record"
          onClick={onToggleRecording}
          active={recording}
          disabled={!recordingSupported}
          title={recordingSupported ? undefined : "This browser can't record meetings"}
          activeClassName="bg-danger/15 text-danger ring-1 ring-danger [filter:drop-shadow(0_0_6px_var(--color-danger))]"
        />
      )}

      <div className="my-1 h-px w-8 shrink-0 bg-border/70" />

      <CallMoreMenu
        pipSupported={pipSupported}
        pipActive={pipActive}
        onTogglePip={onTogglePip}
        onMinimize={onMinimize}
      />

      <div className="mt-auto pt-2">
        <SidebarButton
          icon={<PhoneOff size={20} />}
          label="End"
          onClick={onEnd}
          title="End call"
          className="bg-danger text-white hover:bg-danger hover:brightness-90 hover:text-white"
        />
      </div>
    </nav>
  );
}
