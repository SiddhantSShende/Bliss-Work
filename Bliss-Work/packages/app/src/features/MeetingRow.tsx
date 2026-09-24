/**
 * One meeting, across a row of the list under the calendar.
 *
 * Split out of MeetingList for the reason features/MailRow is split out of
 * MailList: the list fetches, buckets and pages, and the row decides how a
 * single meeting is SAID. They change for different reasons and neither needs
 * to read the other to be understood.
 *
 * Everything the brief asks a row to carry: what the meeting is and what it
 * belongs to, the day and the clock times, who organised it, how many people
 * are on it, and the one action that makes sense for the state it is in. A
 * finished meeting gets no Join — there is nothing left to join — and offers
 * its record instead.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Clock, MoreHorizontal, Phone, PlayCircle, Users, Video } from "lucide-react";
import { Avatar, Badge, Button } from "@taskboard/ui";
import type { CallDTO } from "@taskboard/shared";
import { usePopupDismiss } from "../lib/usePopupDismiss";
import { dayLabel, startOfDay, timeLabel } from "../lib/meetingTime";
import { occurrenceOf } from "../lib/meetingCalendar";
import { bucketFor, meetingScope, statusLabel } from "../lib/meetingView";

export function MeetingRow({
  call,
  search,
  name,
  organiser,
  organiserAvatar,
  compact = false,
  selected = false,
  onOpenRoom,
}: {
  call: CallDTO;
  search: string;
  name: string;
  organiser: string;
  organiserAvatar: string | null | undefined;
  compact?: boolean;
  selected?: boolean;
  onOpenRoom?: (call: CallDTO) => void;
}) {
  const { t } = useTranslation("meetings");
  const nav = useNavigate();
  const { start, end } = occurrenceOf(call);
  const bucket = bucketFor(call);
  // bucketFor only puts LIVE/SCHEDULED calls into these two buckets, so
  // call.status can never be CANCELLED here.
  const joinable = bucket === "upcoming" || bucket === "live";
  const Icon = call.media === "audio" ? Phone : Video;
  const joined = call.participants.filter((p) => p.joinedAt).length;
  const scope = meetingScope(call);

  const openDetail = () => nav({ pathname: `/app/meetings/${call.id}`, search });

  return (
    <li className={`${compact ? "flex flex-col items-stretch gap-2 px-3 py-3" : "flex items-center gap-3 px-3 py-2.5"} transition-colors hover:bg-surface-2/60 ${selected ? "bg-accent-soft/60 ring-1 ring-inset ring-accent/30" : ""}`}>
      <button
        type="button"
        onClick={openDetail}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
            bucket === "live" ? "bg-success/12 text-success" : "bg-accent-soft text-accent"
          }`}
          aria-hidden
        >
          <Icon size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-fg">{name}</span>
            {bucket === "live" ? (
              <Badge tone="success" className="shrink-0">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> {t("row.live")}
              </Badge>
            ) : (
              call.status === "CANCELLED" && (
                <Badge tone="neutral" className="shrink-0">
                  {statusLabel(call)}
                </Badge>
              )
            )}
          </span>
          {scope && <span className="block truncate text-xs text-muted">{scope}</span>}
        </span>
      </button>

      <div className={compact ? "flex items-center gap-1 pl-12 text-xs" : "hidden w-40 shrink-0 sm:block"}>
        <div className="truncate text-xs font-medium text-fg">{dayLabel(start)}</div>
        <div className="flex items-center gap-1 truncate text-xs text-muted">
          <Clock size={11} className="shrink-0" aria-hidden />
          {timeLabel(start)}
          {end > start
            ? // A meeting that runs past midnight ends on a different day than
              // it started, and "9:40 PM – 12:10 AM" reads as a typo unless the
              // day comes with it. Applied inline (rather than as a combined
              // single-line helper) since this row already prints the day on
              // its own line above.
              ` – ${startOfDay(end) === startOfDay(start) ? timeLabel(end) : `${dayLabel(end)}, ${timeLabel(end)}`}`
            : ""}
        </div>
      </div>

      <div className={compact ? "flex items-center gap-2 pl-12" : "hidden w-36 shrink-0 items-center gap-2 lg:flex"}>
        <Avatar name={organiser} src={organiserAvatar} size="sm" />
        <span className="min-w-0">
          <span className="block text-[10px] uppercase tracking-wide text-muted">{t("row.organiser")}</span>
          <span className="block truncate text-xs font-medium text-fg">{organiser}</span>
        </span>
      </div>

      <div
        className={compact ? "flex items-center gap-1 pl-12 text-xs text-muted" : "hidden w-16 shrink-0 items-center gap-1 text-xs text-muted md:flex"}
        title={t("row.inviteJoinTitle", { invited: call.participants.length, joined })}
      >
        <Users size={13} className="shrink-0" aria-hidden />
        {call.participants.length}
      </div>

      <div className={compact ? "flex shrink-0 items-center justify-end gap-1.5" : "flex shrink-0 items-center gap-1.5"}>
        {joinable && onOpenRoom ? (
          <Button size="sm" onClick={() => onOpenRoom(call)}>
            {bucket === "live" ? t("row.join") : t("row.open")}
          </Button>
        ) : (
          // A finished meeting has nothing to join. Where there is a recording
          // it says so and the detail page plays it; otherwise the row just
          // offers its record.
          <Button size="sm" variant="secondary" onClick={openDetail}>
            {call.recordingStatus === "READY" ? (
              <>
                <PlayCircle size={14} /> <span className="hidden sm:inline">{t("row.recording")}</span>
              </>
            ) : (
              t("row.details")
            )}
          </Button>
        )}
        <RowMenu call={call} joinable={joinable} onOpenRoom={onOpenRoom} onOpenDetail={openDetail} />
      </div>
    </li>
  );
}

/** The row overflow. Only actions that genuinely exist for the meeting's state
 *  — a menu offering "Join" on something that ended is a menu that lies. */
function RowMenu({
  call,
  joinable,
  onOpenRoom,
  onOpenDetail,
}: {
  call: CallDTO;
  joinable: boolean;
  onOpenRoom?: (call: CallDTO) => void;
  onOpenDetail: () => void;
}) {
  const { t } = useTranslation("meetings");
  const [open, setOpen] = useState(false);
  const wrap = usePopupDismiss<HTMLDivElement>(open, () => setOpen(false));

  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("row.menu.actionsFor", { title: call.title.trim() || t("row.menu.untitledMeeting") })}
        className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 w-48 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-card"
        >
          <MenuRow label={t("row.menu.viewDetails")} onClick={pick(onOpenDetail)} />
          {joinable && onOpenRoom && (
            <MenuRow
              label={call.status === "LIVE" ? t("row.menu.joinMeeting") : t("row.menu.openRoom")}
              onClick={pick(() => onOpenRoom(call))}
            />
          )}
          {call.recordingStatus === "READY" && (
            <MenuRow label={t("row.menu.watchRecording")} onClick={pick(onOpenDetail)} />
          )}
        </div>
      )}
    </div>
  );
}

function MenuRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="w-full rounded-lg px-2.5 py-1.5 text-left text-sm text-fg transition-colors hover:bg-surface-2"
    >
      {label}
    </button>
  );
}
