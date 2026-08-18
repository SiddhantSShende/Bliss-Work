/**
 * Meetings — one place to see every call you are expected at.
 *
 * The rail item is full-width like Integrations and Org: there is no contextual
 * list pane, because the list IS the page.
 *
 * It reads `GET /api/v1/calls`, which already returns all three call shapes —
 * meetings, channel calls, and 1:1 calls that were scheduled rather than rung —
 * including meetings hosted by another organisation that this user holds a seat
 * in. They are shown together and labelled by kind rather than split into
 * separate screens: "what is on today" does not care where the roster came
 * from, and hiding a channel call here would make this page quietly wrong.
 *
 * Scheduling and the in-call surface are the existing ScheduleCallDialog and
 * CallRoom, unchanged — this page only decides what to list and when the join
 * control is meaningful.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, CalendarPlus, Globe, Hash, Phone, Users, Video } from "lucide-react";
import { Button, EmptyState, PageHeader, Spinner } from "@taskboard/ui";
import type { CallDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { useGoBack } from "../lib/useGoBack";
import { Tabs, type TabSpec } from "../features/Tabs";
import { ScheduleCallDialog } from "../features/ScheduleCallDialog";
import { CallRoom } from "../features/CallRoomLazy";

type View = "upcoming" | "live" | "past";

const KIND_LABEL: Record<CallDTO["kind"], string> = {
  MEETING: "Meeting",
  CHANNEL: "Channel call",
  DIRECT: "Call",
};

/** The moment a call belongs at in the list: when it is meant to happen, or —
 *  for a "meet now" that was never scheduled — when it actually did. */
function whenOf(c: CallDTO): number {
  const iso = c.scheduledAt || c.startedAt || c.endedAt || c.createdAt;
  return new Date(iso).getTime();
}

function startOfDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today" / "Tomorrow" / "Yesterday", else a short calendar date. Relative to
 *  the viewer's own day boundary, which is what a person means by "today". */
function dayLabel(t: number): string {
  const days = Math.round((startOfDay(t) - startOfDay(Date.now())) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return new Date(t).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    // Only spell out the year once it stops being obvious.
    year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

function timeLabel(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Consecutive runs of the same day, in the order the caller sorted them. */
function groupByDay(calls: CallDTO[]): { label: string; items: CallDTO[] }[] {
  const groups: { label: string; items: CallDTO[] }[] = [];
  for (const c of calls) {
    const label = dayLabel(whenOf(c));
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(c);
    else groups.push({ label, items: [c] });
  }
  return groups;
}

export function Meetings() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const goBack = useGoBack();
  const me = useSession((s) => s.user);
  const [view, setView] = useState<View>("upcoming");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [activeCall, setActiveCall] = useState<CallDTO | null>(null);

  const { data: calls = [], isLoading } = useQuery({
    queryKey: qk.calls,
    queryFn: () => api.myCalls(),
  });

  const buckets = useMemo(() => {
    const live = calls.filter((c) => c.status === "LIVE").sort((a, b) => whenOf(b) - whenOf(a));
    const upcoming = calls
      .filter((c) => c.status === "SCHEDULED")
      .sort((a, b) => whenOf(a) - whenOf(b));
    const past = calls
      .filter((c) => c.status === "ENDED" || c.status === "CANCELLED")
      .sort((a, b) => whenOf(b) - whenOf(a));
    return { live, upcoming, past };
  }, [calls]);

  /**
   * Opening a call is one act, whatever state the row is in.
   *
   * This page deliberately does NOT decide whether the call needs starting
   * first. It used to: a SCHEDULED row meant "call /start, then enter", which
   * is a request only the organiser, an org admin or a channel owner is allowed
   * to make — so for everybody else the Join button was a guaranteed 403 dressed
   * up as an error toast, and it stayed that way even once the meeting was
   * genuinely live, because a row that had not been refetched still read
   * SCHEDULED.
   *
   * The room already handles all of it: its token request answers either with a
   * token or with the waiting room, the server decides which, and whoever may
   * open the call is offered the control there. So this just goes in.
   */
  const openCall = (call: CallDTO) => setActiveCall(call);

  if (activeCall) {
    return (
      <CallRoom
        call={activeCall}
        onClose={() => {
          setActiveCall(null);
          // The row's status (and its startedAt) changed underneath us if this
          // was the visit that opened or ended it.
          void qc.invalidateQueries({ queryKey: qk.calls });
        }}
      />
    );
  }

  const TABS: readonly TabSpec<View>[] = [
    { key: "upcoming", label: "Upcoming", badge: buckets.upcoming.length },
    { key: "live", label: "Live", badge: buckets.live.length },
    { key: "past", label: "Past", badge: buckets.past.length },
  ];

  const shown = buckets[view];
  const groups = groupByDay(shown);

  return (
    <div className="flex h-full flex-col">
      
      <PageHeader
        title="Meetings"
        subtitle="Everything you're expected at — scheduled, live, and already done."
        onBack={goBack}
        action={
          <Button size="sm" onClick={() => setScheduleOpen(true)}>
            <CalendarPlus size={15} />
            <span className="hidden sm:inline">New meeting</span>
            <span className="sm:hidden">New</span>
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto max-w-3xl pb-8">
          <Tabs tabs={TABS} active={view} onChange={setView} className="mb-5" />

          {isLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted">
              <Spinner /> Loading…
            </div>
          ) : shown.length === 0 ? (
            <EmptyState
              icon={<Calendar size={26} />}
              title={
                view === "upcoming"
                  ? "Nothing scheduled"
                  : view === "live"
                    ? "Nothing live right now"
                    : "No past meetings"
              }
              hint={
                view === "past"
                  ? "Meetings you've been part of will be listed here once they end."
                  : "Start a meeting now, or put one in the calendar — invite your team, or anyone with a BlissWork account."
              }
            />
          ) : (
            <div className="space-y-6">
              {groups.map((g) => (
                <section key={g.label}>
                  <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted">
                    {g.label}
                  </h2>
                  <div className="space-y-2">
                    {g.items.map((c) => (
                      <MeetingRow
                        key={c.id}
                        call={c}
                        isOrganiser={c.createdBy === me?.id}
                        onOpen={() => openCall(c)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>

      {scheduleOpen && (
        <ScheduleCallDialog
          scope={{ kind: "meeting" }}
          onClose={() => setScheduleOpen(false)}
          onStarted={(call) => {
            setScheduleOpen(false);
            setActiveCall(call);
          }}
        />
      )}
    </div>
  );
}

/** One row. Stacks on a phone so the join control never squeezes the title. */
function MeetingRow({
  call,
  isOrganiser,
  onOpen,
}: {
  call: CallDTO;
  isOrganiser: boolean;
  onOpen: () => void;
}) {
  const live = call.status === "LIVE";
  const done = call.status === "ENDED" || call.status === "CANCELLED";
  const at = whenOf(call);
  const externals = call.participants.filter((p) => p.external).length;

  return (
    <div className="glass flex flex-col gap-3 rounded-2xl p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
            live
              ? "bg-gradient-to-br from-brand-from to-brand-to text-accent-fg shadow-[0_2px_10px_-2px_var(--color-accent)]"
              : "bg-accent-soft text-accent"
          }`}
        >
          {call.media === "audio" ? <Phone size={18} /> : <Video size={18} />}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-fg">
              {call.title || KIND_LABEL[call.kind]}
            </span>
            {live && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[10px] font-medium text-success">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> Live
              </span>
            )}
            {call.status === "CANCELLED" && (
              <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted">
                Cancelled
              </span>
            )}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
            <span title={new Date(at).toLocaleString()}>{timeLabel(at)}</span>
            <span className="flex items-center gap-1">
              {call.kind === "CHANNEL" ? <Hash size={11} /> : null}
              {KIND_LABEL[call.kind]}
            </span>
            {call.participants.length > 0 && (
              <span className="flex items-center gap-1">
                <Users size={11} /> {call.participants.length}
              </span>
            )}
            {externals > 0 && (
              // Same reasoning as in the room itself: someone outside the
              // organisation being here should never have to be inferred.
              <span className="flex items-center gap-1 text-amber-600">
                <Globe size={11} /> {externals} external
              </span>
            )}
          </div>
        </div>
      </div>

      {!done && (
        <div className="shrink-0 sm:pl-3">
          <Button
            variant={live ? "primary" : "subtle"}
            size="sm"
            className="w-full sm:w-auto"
            onClick={onOpen}
          >
            {live ? "Join" : isOrganiser ? "Start" : "Join"}
          </Button>
        </div>
      )}
    </div>
  );
}
