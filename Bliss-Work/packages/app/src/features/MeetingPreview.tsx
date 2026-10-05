import { useTranslation } from "react-i18next";
import { Calendar, Users, Video } from "lucide-react";
import { dayLabel, timeLabel } from "../lib/meetingTime";

/**
 * The read-only recap of what "Schedule Meeting" is about to create: title,
 * when, who, and that it's a video call (every meeting from this form is).
 *
 * Shared, unchanged, by MeetingScheduledDialog — the "meeting details" the
 * confirmation shows are exactly this, since nothing about the meeting
 * changes between scheduling it and confirming it.
 */
export function MeetingPreview({
  title,
  startAt,
  endAt,
  inviteeNames,
  channelNames,
}: {
  title: string;
  startAt: Date | null;
  endAt: Date | null;
  inviteeNames: string[];
  channelNames: string[];
}) {
  const { t } = useTranslation("meetings");

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
      <p className="truncate text-sm font-semibold text-gray-900">
        {title.trim() || t("newMeeting.preview.untitled")}
      </p>
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
