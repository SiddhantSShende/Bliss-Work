/**
 * Who is on a meeting, and what state each of them is in.
 *
 * The roster is the one part of a call that means four different things at
 * once — invited, in the lobby, in the room, already gone — and the API says so
 * with three nullable timestamps rather than a status field. `rosterOf` is the
 * single place that reads them, so the card's counts and the sheet's list can
 * never disagree about what "joined" means.
 *
 * The card's chips are counts; this is the answer to "who ARE they" — name,
 * face, email address — which is why it also carries a search box once the
 * roster is longer than a glance.
 */
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Search, Users } from "lucide-react";
import { Avatar, Badge, EmptyState } from "@taskboard/ui";
import type { CallDTO, CallParticipantDTO } from "@taskboard/shared";
import { useUserLabels } from "../lib/userLabel";
import { useSession } from "../store/session";
import { Sheet } from "./Modal";
import { Tabs, type TabSpec } from "./Tabs";

/** Where one person stands on this call.
 *
 *  "attended" exists because a finished call cannot distinguish "in the room"
 *  from "left": ending a call does not stamp left_at on everyone still in it,
 *  so after the fact the only honest statement is that they were there. */
export type RosterState = "in" | "waiting" | "left" | "attended" | "invited";

const STATE_LABEL: Record<RosterState, string> = {
  in: "In the call",
  waiting: "Waiting",
  left: "Left",
  attended: "Attended",
  invited: "Not joined",
};

interface RosterEntry {
  participant: CallParticipantDTO;
  state: RosterState;
}

function stateOf(call: CallDTO, p: CallParticipantDTO): RosterState {
  const over = call.status === "ENDED" || call.status === "CANCELLED";
  if (over) return p.joinedAt ? "attended" : "invited";
  if (p.joinedAt && !p.leftAt) return "in";
  if (p.waitingSince) return "waiting";
  if (p.joinedAt) return "left";
  return "invited";
}

/**
 * The roster split the two ways the UI asks about it.
 *
 * `invited` is everyone on the roster — being on it IS the invitation, whether
 * they were named when the meeting was made, pulled in mid-call, or arrived on
 * a link. `joined` is everyone who actually turned up, which is why someone who
 * has since left still counts: they were in the meeting.
 */
export function rosterOf(call: CallDTO): { invited: RosterEntry[]; joined: RosterEntry[] } {
  const invited = call.participants.map((participant) => ({
    participant,
    state: stateOf(call, participant),
  }));
  return {
    invited,
    joined: invited.filter((e) => e.state === "in" || e.state === "left" || e.state === "attended"),
  };
}

export type PeopleTab = "invited" | "joined";

/** What the count line calls the list it is counting. */
const TAB_NOUN: Record<PeopleTab, string> = { invited: "invited", joined: "joined" };

/** Below this many people the whole roster fits in one look, and a search box is
 *  one more control to read past on the way to a list of four names. */
const SEARCH_FROM = 8;

/** The roster, opened on whichever count was clicked. */
export function MeetingPeopleSheet({
  call,
  open,
  initialTab,
  onClose,
  labelIds,
}: {
  call: CallDTO;
  open: boolean;
  initialTab: PeopleTab;
  onClose: () => void;
  /** Shared with the card that opened this sheet, so opening it reuses that
   *  page's lookup instead of issuing a second one for a subset. */
  labelIds?: readonly string[];
}) {
  const [tab, setTab] = useState<PeopleTab>(initialTab);
  const [query, setQuery] = useState("");
  // The roster IS the id list, so ask for those people rather than the whole
  // organisation. Falls back to the directory when no gateway is configured.
  const ownIds = useMemo(
    () => call.participants.map((p) => p.userId),
    [call.participants],
  );
  const { nameOf, emailOf } = useUserLabels(labelIds ?? ownIds);
  const me = useSession((st) => st.user);
  const roster = useMemo(() => rosterOf(call), [call]);

  const tabs: readonly TabSpec<PeopleTab>[] = [
    { key: "invited", label: "Invited", badge: roster.invited.length },
    { key: "joined", label: "Joined", badge: roster.joined.length },
  ];

  const q = query.trim().toLowerCase();
  const all = roster[tab];
  const shown = useMemo(() => {
    if (!q) return all;
    // The three things a row shows, so anything on screen is something you can
    // type. `username` is included because it is the email local-part people
    // are used to searching by elsewhere in the app (see lib/matchUser, which
    // takes a directory UserDTO this list does not have).
    return all.filter(({ participant }) =>
      [
        nameOf(participant.userId, participant.username),
        emailOf(participant.userId),
        participant.username,
      ].some((field) => field.toLowerCase().includes(q)),
    );
  }, [all, q, nameOf, emailOf]);

  // Offered on the size of the WHOLE roster, not of the tab in view, so
  // switching to Joined cannot pull the box out from under a live query and
  // leave the list quietly filtered by something you can no longer see.
  const searchable = roster.invited.length >= SEARCH_FROM;

  return createPortal(
    <Sheet open={open} onClose={onClose} title={call.title || "Meeting"} showClose>
      <Tabs tabs={tabs} active={tab} onChange={setTab} className="mb-3" />

      {searchable && (
        <div className="relative mb-3">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search members…"
            aria-label="Search members"
            className="w-full rounded-lg border border-border bg-surface-2 py-2 pl-9 pr-3 text-sm text-fg outline-none focus:border-accent"
          />
        </div>
      )}

      {/* The total said in words as well as on the tab badge: the badge is part
          of a control, and the moment a search narrows the list the number on
          screen and the number of people on the meeting stop being the same. */}
      <p className="mb-2 text-xs text-muted">
        {q
          ? `${shown.length} of ${all.length} shown`
          : `${all.length} member${all.length === 1 ? "" : "s"} ${TAB_NOUN[tab]}`}
      </p>

      {shown.length === 0 ? (
        <EmptyState
          icon={<Users size={22} />}
          title={q ? "No matches" : tab === "joined" ? "Nobody has joined yet" : "Nobody is invited"}
          hint={
            q
              ? "Try another name or email address."
              : tab === "joined"
                ? "People show up here the moment they enter the room."
                : undefined
          }
        />
      ) : (
        <ul className="m-0 list-none space-y-1 p-0">
          {shown.map(({ participant, state }) => (
            <li
              key={participant.userId}
              className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface-2"
            >
              <Avatar name={nameOf(participant.userId, participant.username)} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-fg">
                  {nameOf(participant.userId, participant.username)}
                  {/* Every other people surface in the app marks the signed-in
                      person this way — the room roster, the member sheet, the
                      task picker. This list was the one that did not, so you
                      had to find yourself by reading your own name. */}
                  {participant.userId === me?.id && <span className="text-muted"> (you)</span>}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted">
                  {/* "—" for a guest who joined on a link: they are not in this
                      org's directory, so nobody here has their address. Same
                      placeholder the Inbox uses for the same reason. */}
                  <span className="min-w-0 truncate">{emailOf(participant.userId)}</span>
                  <span aria-hidden="true" className="shrink-0">
                    ·
                  </span>
                  <span className="shrink-0">{STATE_LABEL[state]}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {participant.role === "HOST" && <Badge tone="accent">Host</Badge>}
                {/* Same reasoning as in the room itself: someone from outside
                    the organisation should never have to be inferred. */}
                {participant.external && <Badge tone="warning">External</Badge>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Sheet>,
    document.body,
  );
}
