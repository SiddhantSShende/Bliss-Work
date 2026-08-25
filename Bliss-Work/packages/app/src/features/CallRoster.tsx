/**
 * Who is actually in the room, as a list.
 *
 * The member grid answers "what does the meeting look like"; this answers "is
 * Ada here, and is she muted" — a question a grid of twelve tiles across two
 * pages is bad at. It is also where someone on a page you are not looking at
 * can still be pinned.
 */
import { Hand, Mic, MicOff, Pin, ScreenShare, Video, VideoOff, X } from "lucide-react";
import { Avatar, cn } from "@taskboard/ui";
import type { RoomParticipant } from "../lib/useCallRoom";

export function CallRoster({
  participants,
  hands,
  pinned,
  onTogglePin,
  onClose,
}: {
  participants: RoomParticipant[];
  hands: Set<string>;
  pinned: string | null;
  onTogglePin: (identity: string) => void;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Members"
      className="flex w-full shrink-0 flex-col border-l border-border/70 bg-surface sm:max-w-xs"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
        <span className="truncate text-sm font-semibold text-fg">
          Members <span className="text-xs font-normal text-muted">{participants.length}</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close members"
          aria-label="Close members"
          className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <X size={15} />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {participants.map((p) => (
          <div
            key={p.identity}
            className="group flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-surface-2"
          >
            <Avatar name={p.name} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-fg">
                {p.name}
                {p.isLocal && <span className="text-muted"> (you)</span>}
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted">
                {p.sharing && (
                  <span className="flex items-center gap-1 text-danger">
                    <ScreenShare size={11} /> Sharing
                  </span>
                )}
                {hands.has(p.identity) && (
                  <span className="flex items-center gap-1 text-warning">
                    <Hand size={11} /> Hand up
                  </span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1 text-muted">
              {p.micOn ? <Mic size={13} /> : <MicOff size={13} className="text-danger" />}
              {p.camOn ? <Video size={13} /> : <VideoOff size={13} />}
              <button
                type="button"
                onClick={() => onTogglePin(p.identity)}
                title={pinned === p.identity ? `Unpin ${p.name}` : `Pin ${p.name}`}
                aria-label={pinned === p.identity ? `Unpin ${p.name}` : `Pin ${p.name}`}
                aria-pressed={pinned === p.identity}
                className={cn(
                  "rounded-md p-1 transition-colors hover:bg-border/60 hover:text-fg",
                  pinned === p.identity ? "text-accent opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                )}
              >
                <Pin size={13} className={cn(pinned === p.identity && "fill-current")} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
