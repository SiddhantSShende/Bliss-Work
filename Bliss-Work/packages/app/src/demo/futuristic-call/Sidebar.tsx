import { useState } from "react";
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
import { SidebarButton } from "../../features/SidebarButton";

export function Sidebar({
  chatActive,
  unreadChat,
  onToggleChat,
  onEndCall,
}: {
  chatActive: boolean;
  unreadChat: number;
  onToggleChat: () => void;
  onEndCall: () => void;
}) {
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [recording, setRecording] = useState(false);

  return (
    <nav
      aria-label="Meeting controls"
      className="glass relative z-20 flex w-20 shrink-0 flex-col items-center gap-1 overflow-y-auto rounded-r-3xl py-4"
    >
      <SidebarButton
        icon={micOn ? <Mic size={20} /> : <MicOff size={20} />}
        label={micOn ? "Mute" : "Muted"}
        onClick={() => setMicOn((v) => !v)}
        active={!micOn}
        activeClassName="text-danger ring-1 ring-danger/50"
      />
      <SidebarButton
        icon={camOn ? <Video size={20} /> : <VideoOff size={20} />}
        label="Camera"
        onClick={() => setCamOn((v) => !v)}
        active={!camOn}
        activeClassName="text-danger ring-1 ring-danger/50"
      />
      <SidebarButton icon={<ScreenShare size={20} />} label="Share" onClick={() => setSharing((v) => !v)} active={sharing} />
      <SidebarButton
        icon={<Hand size={20} />}
        label="Raise"
        onClick={() => setHandRaised((v) => !v)}
        active={handRaised}
        activeClassName="bg-warning/15 text-warning ring-1 ring-warning [filter:drop-shadow(0_0_6px_var(--color-warning))]"
      />
      <SidebarButton
        icon={<Users size={20} />}
        label="People"
        onClick={() => setParticipantsOpen((v) => !v)}
        active={participantsOpen}
      />
      <SidebarButton icon={<UserPlus size={20} />} label="Add" onClick={() => {}} title="Add people" />
      <SidebarButton icon={<Link2 size={20} />} label="Invite" onClick={() => {}} title="Copy invite link" />
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
        onClick={() => setNotesOpen((v) => !v)}
        active={notesOpen}
      />
      <SidebarButton
        icon={<Disc size={20} className={recording ? "fill-current" : undefined} />}
        label="Record"
        onClick={() => setRecording((v) => !v)}
        active={recording}
        activeClassName="bg-danger/15 text-danger ring-1 ring-danger [filter:drop-shadow(0_0_6px_var(--color-danger))]"
      />

      <div className="my-1 h-px w-8 shrink-0 bg-border/70" />

      <div className="mt-auto pt-2">
        <SidebarButton
          icon={<PhoneOff size={20} />}
          label="End"
          onClick={onEndCall}
          title="End call"
          className="bg-danger text-white hover:bg-danger hover:brightness-90 hover:text-white"
        />
      </div>
    </nav>
  );
}
