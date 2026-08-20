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
 * CallRoom, unchanged — this page only decides what to list, and each row is a
 * MeetingCard, which owns everything said ABOUT a call.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, CalendarPlus } from "lucide-react";
import { Button, EmptyState, PageHeader, Spinner } from "@taskboard/ui";
import type { CallDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { useGoBack } from "../lib/useGoBack";
import { openCallTab } from "../lib/callWindow";
import { groupByDay, whenOf } from "../lib/meetingTime";
import { Tabs, type TabSpec } from "../features/Tabs";
import { ScheduleCallDialog } from "../features/ScheduleCallDialog";
import { MeetingCard } from "../features/MeetingCard";
import { useMeetingSession } from "../lib/MeetingSession";

type View = "upcoming" | "live" | "past";

export function Meetings() {
  const { api, config } = useRuntime();
  const qc = useQueryClient();
  const goBack = useGoBack();
  const [view, setView] = useState<View>("upcoming");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const { enter, restore, call: active } = useMeetingSession();

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
   *
   * It goes in A NEW TAB, so the meeting and the rest of BlissWork stop being
   * the same surface — see lib/callWindow. Where there is no tab to open (the
   * desktop app; a blocked pop-up) the room opens in place exactly as it always
   * did, which is why this page still holds the fallback.
   */
  const openCall = (call: CallDTO) => {
    // Already in it — including minimised, which is the case that matters:
    // "Join" on a meeting you never left should bring it back, not open a
    // second door into the room you are standing in.
    if (active?.id === call.id) {
      restore();
      return;
    }
    if (openCallTab(call.id, config)) return;
    // In place — but held by the session above the router, not by this page, so
    // the meeting survives navigating away and can be minimised.
    enter(call, () => {
      // The row's status (and its startedAt) changed underneath us if this was
      // the visit that opened or ended it.
      void qc.invalidateQueries({ queryKey: qk.calls });
    });
  };

  // ONE id set for the whole page, not one per card.
  //
  // The name lookup is cached by the set it was asked for, so a card computing
  // its own would get its own cache entry and its own request — twenty meetings
  // on screen, twenty requests. Built from `calls` rather than from what is
  // currently filtered into view so the set (and therefore the cache entry)
  // does not change when the user switches between Upcoming / Live / Past.
  const labelIds = useMemo(
    () => calls.flatMap((c) => [...c.participants.map((p) => p.userId), c.createdBy]),
    [calls],
  );

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
                      <MeetingCard
                        key={c.id}
                        call={c}
                        labelIds={labelIds}
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
            // "Meet now" is a join like any other, and lands in the same tab
            // the Join button would have opened.
            openCall(call);
          }}
        />
      )}
    </div>
  );
}
