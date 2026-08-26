/**
 * Who is actually in the room, as a list.
 *
 * The member grid answers "what does the meeting look like"; this answers "is
 * Ada here, and is she muted" — a question a grid of twelve tiles across two
 * pages is bad at. It is also where someone on a page you are not looking at
 * can still be pinned.
 *
 * Fixed in the layout rather than a panel that opens and closes: "who is
 * here" is a question the room should always be able to answer without a
 * click, so there is no close control here — see CallRoom.
 */
import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Hand,
  Mic,
  MicOff,
  Pin,
  ScreenShare,
  Search,
  UserPlus,
  Video,
  VideoOff,
} from "lucide-react";
import { Avatar, Button, cn } from "@taskboard/ui";
import type { RoomParticipant } from "../lib/useCallRoom";
import { SpeakingWave } from "./SpeakingWave";

/** Rows shown before the list folds the rest under "+N more members". */
const VISIBLE_LIMIT = 8;

export function CallRoster({
  participants,
  hands,
  pinned,
  onTogglePin,
  canInvite = true,
  inviteTitle,
  onInvite,
  className,
}: {
  participants: RoomParticipant[];
  hands: Set<string>;
  pinned: string | null;
  onTogglePin: (identity: string) => void;
  /** False where the room has nobody left to invite — see CallRoom's
   *  `canAddPeople` (a channel call's roster IS the channel's membership). */
  canInvite?: boolean;
  /** Why, when `canInvite` is false — a disabled button that doesn't say why
   *  it's disabled is just a broken one. */
  inviteTitle?: string;
  /** Omitted where there's nowhere for an invite to go (e.g. no call row
   *  yet) — the button only renders when there's something for it to do. */
  onInvite?: () => void;
  /** Sizing/positioning, set by the caller's layout. */
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return participants;
    return participants.filter((p) => p.name.toLowerCase().includes(q));
  }, [participants, query]);

  // Collapsed by default so a big room doesn't hand the panel a wall of rows
  // before anyone's asked for them; a search bypasses the fold outright — a
  // match you typed for should never hide behind "+N more".
  const searching = query.trim().length > 0;
  const visible = expanded || searching ? filtered : filtered.slice(0, VISIBLE_LIMIT);
  const hiddenCount = filtered.length - visible.length;

  return (
    <aside
      aria-label="Participants"
      className={cn("glass flex flex-col overflow-hidden rounded-2xl", className)}
    >
      <header className="shrink-0 border-b border-border/70 px-4 py-3">
        <span className="truncate text-sm font-semibold text-fg">
          Participants <span className="font-normal text-muted">({participants.length})</span>
        </span>
      </header>

      <div className="shrink-0 border-b border-border/70 p-3">
        <label className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5">
          <Search size={14} className="shrink-0 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search members…"
            aria-label="Search members"
            className="w-full min-w-0 bg-transparent text-xs text-fg outline-none placeholder:text-muted/70"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
          In meeting · {filtered.length}
        </div>

        <div className="space-y-0.5">
          {visible.map((p) => (
            <div
              key={p.identity}
              className={cn(
                "group flex items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors",
                p.speaking ? "bg-accent-soft/70 ring-1 ring-accent/40" : "hover:bg-surface-2",
              )}
            >
              <Avatar name={p.name} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm font-medium text-fg">
                  <span className="truncate">
                    {p.name}
                    {p.isLocal && <span className="text-muted"> (you)</span>}
                  </span>
                  {p.speaking && <SpeakingWave className="text-accent" />}
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

          {!searching && hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <ChevronDown size={13} /> +{hiddenCount} more members
            </button>
          )}
          {!searching && expanded && filtered.length > VISIBLE_LIMIT && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <ChevronUp size={13} /> Show less
            </button>
          )}
          {searching && filtered.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted">No members match "{query.trim()}".</p>
          )}
        </div>
      </div>

      {onInvite && (
        <div className="shrink-0 border-t border-border/70 p-3">
          <Button
            size="sm"
            className="w-full"
            onClick={onInvite}
            disabled={!canInvite}
            title={canInvite ? undefined : inviteTitle}
          >
            <UserPlus size={14} /> Invite members
          </Button>
        </div>
      )}
    </aside>
  );
}
