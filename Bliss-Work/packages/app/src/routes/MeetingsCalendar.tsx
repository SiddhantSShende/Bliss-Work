/**
 * Meetings, as a calendar.
 *
 * A full-height page with the existing meeting list in a narrow left pane and
 * the calendar in a large right pane. The list and calendar keep separate
 * scroll boundaries so the calendar remains readable through the full day.
 *
 * ── Where the meetings come from ─────────────────────────────────────────────
 * The GRID reads `myCallsInRange(from, to)` — a window, not a page. Neither
 * existing read could serve it: `myCalls()` caps finished calls at a month, so
 * navigating back past one showed an empty week that was not empty, and
 * `myCallHistory()` is a newest-first cursor that excludes SCHEDULED and LIVE.
 * See the client method and store/calls_range.go.
 *
 * The LIST below is unchanged in substance — still `myCalls()` for Upcoming and
 * Live and the keyset `myCallHistory()` for Past, because those three answer
 * "what am I expected at", which is a different question from "what is in this
 * week" and should not empty out when somebody pages the calendar to March.
 *
 * ── Which week is on screen ──────────────────────────────────────────────────
 * In the URL (`?d=` and `?scale=`), beside the bucket that was already there,
 * for the reason lib/meetingView gives: opening a meeting and coming back has
 * to return to what the user was looking at, and the detail pane is a different
 * route. A link to this page is a link to a specific week.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertCircle, CalendarPlus, ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Spinner } from "@taskboard/ui";
import type { CallDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { useUserLabels } from "../lib/userLabel";
import { startOfDay } from "../lib/meetingTime";
import { openCallTab } from "../lib/callWindow";
import { useMeetingSession } from "../lib/MeetingSession";
import {
  CALENDAR_SCALES,
  anchorParam,
  daysIn,
  gridRangeOf,
  hourWindowFor,
  isCalendarScale,
  parseAnchor,
  rangeLabel,
  shiftAnchor,
  type CalendarScale,
} from "../lib/meetingCalendar";
import { bucketFor, NO_MEETING_FILTER, matchesFilter, type MeetingFilter } from "../lib/meetingView";
import { NewMeetingDialog } from "../features/NewMeetingDialog";
import { MeetingFilterMenu } from "../features/MeetingFilterMenu";
import { MeetingWeekGrid } from "../features/MeetingWeekGrid";
import { MeetingMonthGrid } from "../features/MeetingMonthGrid";
import { MeetingList } from "./MeetingList";

export function MeetingsCalendar() {
  const { t } = useTranslation("meetings");
  const [params, setParams] = useSearchParams();
  const { api, config } = useRuntime();
  const qc = useQueryClient();
  const viewerId = useSession((s) => s.user?.id ?? null);
  const { enter, restore, call: activeCall } = useMeetingSession();

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  // Filters are a way of LOOKING at the page, not a place in it: they are not
  // in the URL, so a shared link is the week rather than one person's
  // narrowing of it.
  const [filter, setFilter] = useState<MeetingFilter>(NO_MEETING_FILTER);

  const scaleParam = params.get("scale");
  const scale: CalendarScale = isCalendarScale(scaleParam) ? scaleParam : "week";
  const anchor = parseAnchor(params.get("d"));
  const range = useMemo(() => gridRangeOf(anchor, scale), [anchor, scale]);
  const days = useMemo(() => daysIn(range), [range]);

  // Recomputed once a minute rather than per render, so the now-line and the
  // Live/Upcoming split move on their own without every keystroke elsewhere
  // re-deciding what time it is.
  const now = useNow();

  const fromISO = new Date(range.start).toISOString();
  const toISO = new Date(range.end).toISOString();
  const grid = useQuery({
    queryKey: qk.callsRange(fromISO, toISO),
    queryFn: () => api.myCallsInRange(fromISO, toISO),
  });

  const visible = useMemo(
    () => (grid.data ?? []).filter((c) => matchesFilter(c, filter, viewerId)),
    [grid.data, filter, viewerId],
  );

  // ONE id set for the whole grid, for the reason MeetingList gives: the name
  // lookup is cached by the set it was asked for, so a block resolving its own
  // organiser would get its own cache entry and its own request.
  const labelIds = useMemo(() => visible.map((c) => c.createdBy), [visible]);
  const { nameOf } = useUserLabels(labelIds);

  const hourWindow = useMemo(() => hourWindowFor(visible, days), [visible, days]);

  const setView = (next: { anchor?: number; scale?: CalendarScale }) => {
    const p = new URLSearchParams(params);
    if (next.anchor !== undefined) p.set("d", anchorParam(next.anchor));
    if (next.scale !== undefined) p.set("scale", next.scale);
    setParams(p, { replace: true });
  };

  const selectMeeting = (call: CallDTO) => {
    const next = new URLSearchParams(params);
    next.set("view", bucketFor(call));
    setParams(next, { replace: true });
    setSelectedMeetingId(call.id);
  };

  /** Opening a meeting is one act whatever state it is in — the room decides
   *  whether it needs starting first. Unchanged from the folder column this
   *  button moved out of. */
  const openRoom = (call: CallDTO) => {
    if (activeCall?.id === call.id) {
      restore();
      return;
    }
    if (openCallTab(call.id, config)) return;
    enter(call, () => void qc.invalidateQueries({ queryKey: qk.calls }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border/60 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight text-fg">
              {t("calendar.title")}
            </h1>
            <p className="mt-0.5 text-sm text-muted">
              {t("calendar.subtitle")}
            </p>
          </div>
          <Button size="sm" onClick={() => setScheduleOpen(true)}>
            <CalendarPlus size={15} />
            {t("calendar.newMeeting")}
          </Button>
        </div>

      </header>

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(14rem,35%)_minmax(0,1fr)] gap-3 overflow-hidden p-3 sm:p-4 lg:grid-cols-[minmax(17rem,28%)_minmax(0,1fr)] lg:grid-rows-1">
        <section className="min-h-0 overflow-hidden rounded-xl border border-border/70 bg-surface">
          <MeetingList
            filter={filter}
            onFilterChange={setFilter}
            selectedMeetingId={selectedMeetingId}
            onOpenRoom={openRoom}
          />
        </section>

        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-surface">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 p-3">
            <button
              type="button"
              onClick={() => setView({ anchor: startOfDay(Date.now()) })}
              className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-surface-2"
            >
              {t("calendar.today")}
            </button>
            <div className="flex items-center rounded-lg border border-border bg-surface">
              <StepButton
                label={scale === "week" ? t("calendar.previousWeek") : t("calendar.previousMonth")}
                onClick={() => setView({ anchor: shiftAnchor(anchor, scale, -1) })}
              >
                <ChevronLeft size={16} />
              </StepButton>
              <span className="h-5 w-px bg-border" aria-hidden />
              <StepButton
                label={scale === "week" ? t("calendar.nextWeek") : t("calendar.nextMonth")}
                onClick={() => setView({ anchor: shiftAnchor(anchor, scale, 1) })}
              >
                <ChevronRight size={16} />
              </StepButton>
            </div>
            <span className="min-w-0 truncate text-sm font-semibold text-fg">{rangeLabel(anchor, scale)}</span>
            <div className="ml-auto flex rounded-lg border border-border bg-surface p-0.5">
              {CALENDAR_SCALES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  aria-pressed={s.key === scale}
                  onClick={() => setView({ scale: s.key })}
                  className={`rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${s.key === scale ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"}`}
                >
                  {t(`calendar.scale.${s.key}`)}
                </button>
              ))}
            </div>
          </div>

          {grid.isLoading ? (
            <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted">
              <Spinner /> {t("calendar.loading")}
            </div>
          ) : grid.isError ? (
            // z.array(CallDTO) fails its ENTIRE parse if one row is malformed,
            // which would render as a genuinely empty week. That is the one
            // case that must never look like a free calendar.
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <AlertCircle size={22} className="text-muted" />
              <div className="text-sm font-medium text-fg">{t("calendar.error.title")}</div>
              <Button size="sm" variant="secondary" onClick={() => void grid.refetch()}>
                {t("calendar.error.retry")}
              </Button>
            </div>
          ) : scale === "week" ? (
            <MeetingWeekGrid
              days={days}
              calls={visible}
              window={hourWindow}
              now={now}
              onOpen={selectMeeting}
              nameOf={nameOf}
            />
          ) : (
            <MeetingMonthGrid
              days={days}
              calls={visible}
              anchor={anchor}
              now={now}
              onOpen={selectMeeting}
              onPickDay={(day) => setView({ anchor: day, scale: "week" })}
              nameOf={nameOf}
            />
          )}
        </section>
      </div>

      {scheduleOpen && (
        <NewMeetingDialog
          onClose={() => setScheduleOpen(false)}
          onStarted={(call) => {
            setScheduleOpen(false);
            openRoom(call);
          }}
        />
      )}
    </div>
  );
}

function StepButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="px-2 py-1.5 text-muted transition-colors hover:text-accent"
    >
      {children}
    </button>
  );
}

/** The current minute, as state. A calendar that renders "now" has to move
 *  without a reload — the now line, and which side of Live a meeting falls on.
 *  Once a minute is as often as either can visibly change, and the interval is
 *  torn down with the page rather than left running for the session. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
