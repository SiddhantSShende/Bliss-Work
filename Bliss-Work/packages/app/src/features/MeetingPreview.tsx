import { useTranslation } from "react-i18next";
import { Calendar, Clock, Hash, Repeat, Users, Video } from "lucide-react";
import { dayLabel, durationLabel, timeLabel } from "../lib/meetingTime";
import { MEETING_TONES, type MeetingClasses } from "./meetingTone";
import type { PickerTone } from "./pickerTone";

/**
 * The read-only recap of what "Schedule Meeting" is about to create: title,
 * when, who, and that it's a video call (every meeting from this form is).
 *
 * Two layouts of the same facts:
 *  - "summary" (default) — the compact recap MeetingScheduledDialog shows once
 *    the meeting exists, unchanged.
 *  - "card" — the live preview on the New Meeting form: one labelled row each for
 *    the date, the time and its duration, the repeat rule, how many people and
 *    channels, and the online indicator, with the form's own action buttons in
 *    `actions` at the bottom so the preview and what you do with it are one unit.
 */
export function MeetingPreview({
  title,
  startAt,
  endAt,
  inviteeNames,
  channelNames,
  layout = "summary",
  repeat,
  actions,
  tone = "light",
}: {
  title: string;
  startAt: Date | null;
  endAt: Date | null;
  inviteeNames: string[];
  channelNames: string[];
  layout?: "summary" | "card";
  /** Card only: the repeat rule, already worded ("Does not repeat"). */
  repeat?: string;
  /** Card only: the buttons, pinned below a divider. */
  actions?: React.ReactNode;
  /** Card only: "theme" paints it with the app's surface tokens (dark mode). */
  tone?: PickerTone;
}) {
  const { t, i18n } = useTranslation("meetings");
  const c = MEETING_TONES[tone];
  const heading = title.trim() || t("newMeeting.preview.untitled");

  if (layout === "card") {
    const sameDay = !!startAt && !!endAt && startAt.toDateString() === endAt.toDateString();
    const dateOf = (d: Date, withYear: boolean) =>
      d.toLocaleDateString(i18n.language, {
        weekday: "short",
        month: "short",
        day: "numeric",
        ...(withYear ? { year: "numeric" } : {}),
      });
    const range =
      startAt && endAt
        ? `${timeLabel(startAt.getTime())} – ${timeLabel(endAt.getTime())}${
            sameDay ? "" : ` (${t("newMeeting.preview.endsOn", { date: dateOf(endAt, false) })})`
          }`
        : "—";
    const duration = startAt && endAt ? durationLabel(t, startAt.getTime(), endAt.getTime()) : "";

    return (
      <section
        aria-label={t("newMeeting.preview.sectionTitle")}
        className={`flex flex-col rounded-xl border ${c.previewCard}`}
      >
        <div className="flex flex-col gap-1.5 px-3 pb-2.5 pt-3">
          <span className={`text-xs font-semibold uppercase tracking-wide ${c.heading}`}>
            {t("newMeeting.preview.sectionTitle")}
          </span>
          <p className={`truncate text-base font-semibold ${c.strong}`}>{heading}</p>
          <dl className={`flex flex-col gap-1 text-sm ${c.body}`}>
            <Row tone={c} icon={<Calendar size={14} />} label={t("newMeeting.preview.dateLabel")}>
              {startAt ? dateOf(startAt, true) : t("newMeeting.preview.pickATime")}
            </Row>
            <Row tone={c} icon={<Clock size={14} />} label={t("newMeeting.preview.timeLabel")}>
              {range}
              {duration && <span className={`whitespace-nowrap ${c.muted}`}> · {duration}</span>}
            </Row>
            <Row tone={c} icon={<Repeat size={14} />} label={t("newMeeting.preview.repeatLabel")}>
              {repeat ?? t("newMeeting.repeat.none")}
            </Row>
            <Row tone={c} icon={<Users size={14} />} label={t("newMeeting.preview.peopleLabel")}>
              {t("newMeeting.preview.members", { count: inviteeNames.length })}
            </Row>
            <Row tone={c} icon={<Hash size={14} />} label={t("newMeeting.preview.channelsLabel")}>
              {t("newMeeting.preview.channels", { count: channelNames.length })}
            </Row>
            <Row tone={c} icon={<Video size={14} />} label={t("newMeeting.preview.videoLabel")}>
              {t("newMeeting.preview.onlineMeeting")}
            </Row>
          </dl>
        </div>
        {actions && (
          <div className={`grid grid-cols-[1fr_1.4fr] gap-2 border-t px-3 py-2.5 ${c.divider}`}>{actions}</div>
        )}
      </section>
    );
  }

  const when =
    startAt && endAt
      ? `${dayLabel(startAt.getTime())} · ${timeLabel(startAt.getTime())} – ${timeLabel(endAt.getTime())}`
      : t("newMeeting.preview.pickATime");

  const audience = [...inviteeNames, ...channelNames.map((c) => `#${c}`)];
  const who = audience.length ? audience.join(", ") : t("newMeeting.preview.noInvitees");

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-gray-200 bg-gray-50 p-3">
      <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
        {t("newMeeting.preview.sectionTitle")}
      </span>
      <p className="truncate text-sm font-semibold text-gray-900">{heading}</p>
      <div className="flex items-center gap-2 text-sm text-gray-700">
        <Calendar size={14} className="shrink-0 text-accent" aria-hidden />
        <span className="truncate">{when}</span>
      </div>
      <div className="flex items-center gap-2 text-sm text-gray-700">
        <Users size={14} className="shrink-0 text-accent" aria-hidden />
        <span className="truncate">{who}</span>
      </div>
      <div className="flex items-center gap-2 text-sm text-gray-700">
        <Video size={14} className="shrink-0 text-accent" aria-hidden />
        <span>{t("newMeeting.preview.onlineMeeting")}</span>
      </div>
    </div>
  );
}

/** One labelled fact: icon, a small fixed-width label, then the value. The label is
 *  what a screen reader hears; the icon is decoration. */
function Row({
  icon,
  label,
  tone,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  tone: MeetingClasses;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1rem_4.25rem_minmax(0,1fr)] items-start gap-x-2">
      <span aria-hidden="true" className="pt-0.5 text-accent">
        {icon}
      </span>
      <dt className={`pt-0.5 text-xs ${tone.muted}`}>{label}</dt>
      <dd className={`min-w-0 break-words ${tone.strong}`}>{children}</dd>
    </div>
  );
}
