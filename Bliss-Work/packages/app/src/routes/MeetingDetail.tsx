import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AlertCircle, Disc, Hash, PlayCircle, Repeat, ScreenShare, Video } from "lucide-react";
import { Avatar, Badge, Button, Spinner } from "@taskboard/ui";
import type { CallDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { useUserLabels } from "../lib/userLabel";
import { describeRecurrence } from "../lib/meetingRecurrence";
import { openCallTab } from "../lib/callWindow";
import { useMeetingSession } from "../lib/MeetingSession";
import { dayLabel, timeLabel, whenOf } from "../lib/meetingTime";
import {
  bucketFor,
  durationLabel,
  durationMsOf,
  meetingDisplayName,
  statusLabel,
} from "../lib/meetingView";
import { Tabs, type TabSpec } from "../features/Tabs";
import { MeetingInviteLink } from "../features/MeetingInviteLink";
import { MeetingSeriesActions } from "../features/MeetingSeriesActions";
import { MeetingChatPanel, MeetingNotesPanel } from "../features/MeetingTranscript";

/**
 * Meetings' third container: one meeting, in full.
 *
 * Everything stored about a call, in the one place that shows all of it — who
 * was invited and who actually turned up, when it started and ended and how
 * long it ran, whether it was recorded, what was shared, and (the two things
 * that used not to outlive the room at all) its chat and its notes.
 *
 * ── Where the data comes from ────────────────────────────────────────────────
 * `GET /calls/{id}` for the meeting itself, which already carried the roster,
 * the timings, the live shares and the recording status. The transcript is the
 * one addition — see features/MeetingTranscript.
 *
 * Fetched by id rather than read out of the list, deliberately: a meeting
 * opened from Past is not in the Upcoming/Live query at all, and a deep link
 * into a meeting has no list behind it.
 */
type Panel = "overview" | "chat" | "notes";

export function MeetingDetail() {
  const { t, i18n } = useTranslation("meetings");
  const { callId = "" } = useParams();
  const { api, config } = useRuntime();
  const qc = useQueryClient();
  const viewerId = useSession((s) => s.user?.id ?? null);
  const [panel, setPanel] = useState<Panel>("overview");
  const { enter, restore, call: activeCall } = useMeetingSession();

  const { data: call, isLoading, isError, refetch } = useQuery({
    queryKey: qk.call(callId),
    queryFn: () => api.call(callId),
    enabled: !!callId,
  });

  const labelIds = useMemo(
    () => (call ? [...call.participants.map((p) => p.userId), call.createdBy] : []),
    [call],
  );
  const { nameOf, avatarUrlOf } = useUserLabels(labelIds);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
        <Spinner /> {t("detail.loading")}
      </div>
    );
  }
  if (isError || !call) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertCircle size={24} className="text-muted" />
        <div className="text-sm font-medium text-fg">{t("detail.error.title")}</div>
        <Button size="sm" variant="secondary" onClick={() => void refetch()}>
          {t("detail.error.retry")}
        </Button>
      </div>
    );
  }

  const bucket = bucketFor(call);
  const name = meetingDisplayName(call, nameOf, viewerId);
  const joinable = bucket === "upcoming" || bucket === "live";

  /** Opening a meeting is one act whatever state the row is in — the room
   *  decides whether it needs starting first, and offers the control to
   *  whoever may. Unchanged from the previous Meetings page. */
  const open = () => {
    if (activeCall?.id === call.id) {
      restore();
      return;
    }
    if (openCallTab(call.id, config)) return;
    enter(call, () => void qc.invalidateQueries({ queryKey: qk.calls }));
  };

  const TABS: readonly TabSpec<Panel>[] = [
    { key: "overview", label: t("detail.tabs.overview") },
    { key: "chat", label: t("detail.tabs.chat") },
    { key: "notes", label: t("detail.tabs.notes") },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border/60 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold tracking-tight text-fg">{name}</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
              <span>{t(KIND_LABEL_KEY[call.kind])}</span>
              <span aria-hidden>·</span>
              <span>{dayLabel(whenOf(call))}</span>
              {/* The title is shown above; when there ISN'T one the heading is
                  already the people, so this does not repeat them. */}
              {call.title.trim() === "" && <span className="italic">{t("detail.noTitleSet")}</span>}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <MeetingSeriesActions call={call} />
            <MeetingStatusBadge call={call} />
            {joinable && (
              <Button size="sm" onClick={open}>
                <Video size={15} />
                {bucket === "live" ? t("detail.join") : t("detail.open")}
              </Button>
            )}
          </div>
        </div>

        <Tabs tabs={TABS} active={panel} onChange={setPanel} className="mt-3" />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {panel === "overview" ? (
          <MeetingOverview call={call} nameOf={nameOf} avatarUrlOf={avatarUrlOf} />
        ) : panel === "chat" ? (
          <MeetingChatPanel callId={call.id} />
        ) : (
          <MeetingNotesPanel callId={call.id} />
        )}
      </div>
    </div>
  );
}

const KIND_LABEL_KEY: Record<CallDTO["kind"], string> = {
  MEETING: "detail.kindLabel.meeting",
  CHANNEL: "detail.kindLabel.channelCall",
  DIRECT: "detail.kindLabel.call",
};

function MeetingStatusBadge({ call }: { call: CallDTO }) {
  const { t } = useTranslation("meetings");
  if (call.status === "LIVE") {
    return (
      <Badge tone="success">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> {t("detail.live")}
      </Badge>
    );
  }
  return (
    <Badge tone={call.status === "SCHEDULED" ? "accent" : "neutral"}>{statusLabel(call)}</Badge>
  );
}

/**
 * The facts, and the roster.
 *
 * Invited and joined are shown as ONE list with a state on each person rather
 * than two lists, because the interesting question about a finished meeting is
 * "who was invited and didn't come", and two lists make that a subtraction the
 * reader has to do.
 */
function MeetingOverview({
  call,
  nameOf,
  avatarUrlOf,
}: {
  call: CallDTO;
  nameOf: (id: string) => string;
  avatarUrlOf: (id: string) => string | null | undefined;
}) {
  const { t, i18n } = useTranslation("meetings");
  const start = whenOf(call);
  const joined = call.participants.filter((p) => p.joinedAt);

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>{t("detail.overview.when.sectionTitle")}</SectionTitle>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Fact label={t("detail.overview.when.date")} value={new Date(start).toLocaleDateString(i18n.language, {
            weekday: "short", day: "numeric", month: "short", year: "numeric",
          })} />
          <Fact label={t("detail.overview.when.start")} value={call.startedAt ? timeLabel(new Date(call.startedAt).getTime()) : timeLabel(start)} />
          {/* An end only once there IS one. A live meeting has not ended, and a
              scheduled one's planned end is a plan — shown as such. */}
          <Fact
            label={call.endedAt ? t("detail.overview.when.end") : t("detail.overview.when.scheduledEnd")}
            value={
              call.endedAt
                ? timeLabel(new Date(call.endedAt).getTime())
                : call.endsAt
                  ? timeLabel(new Date(call.endsAt).getTime())
                  : "—"
            }
          />
          <Fact
            label={call.status === "LIVE" ? t("detail.overview.when.runningFor") : t("detail.overview.when.duration")}
            value={durationLabel(durationMsOf(call))}
          />
        </dl>
      </section>

      <section>
        <SectionTitle>
          {t("detail.overview.people.sectionTitle", { joined: joined.length, total: call.participants.length })}
        </SectionTitle>
        {call.participants.length === 0 ? (
          <p className="text-sm text-muted">{t("detail.overview.people.empty")}</p>
        ) : (
          <ul className="space-y-1.5">
            {call.participants.map((p) => (
              <li key={p.userId} className="flex items-center gap-2.5">
                <Avatar name={nameOf(p.userId)} src={avatarUrlOf(p.userId)} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-fg">{nameOf(p.userId)}</span>
                    {p.role === "HOST" && <Badge tone="accent">{t("detail.overview.people.host")}</Badge>}
                    {p.external && <Badge tone="warning">{t("detail.overview.people.external")}</Badge>}
                  </div>
                  <p className="text-xs text-muted">{attendanceOf(p, call, t)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionTitle>{t("detail.overview.meeting.sectionTitle")}</SectionTitle>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Fact label={t("detail.overview.meeting.organisedBy")} value={nameOf(call.createdBy)} />
          {call.startedBy && call.startedBy !== call.createdBy && (
            <Fact label={t("detail.overview.meeting.openedBy")} value={nameOf(call.startedBy)} />
          )}
          <Fact label={t("detail.overview.meeting.media")} value={call.media === "audio" ? t("detail.overview.meeting.audioOnly") : t("detail.overview.meeting.video")} />
          <Fact
            label={t("detail.overview.meeting.recording")}
            value={
              call.recordingStatus === "READY"
                ? t("detail.overview.meeting.recordingAvailable")
                : call.recordingStatus === "RECORDING"
                  ? t("detail.overview.meeting.recordingInProgress")
                  : t("detail.overview.meeting.recordingNotRecorded")
            }
            icon={call.recordingStatus ? <Disc size={13} /> : undefined}
          />
          {call.channelId && <Fact label={t("detail.overview.meeting.channelCall")} value={t("detail.overview.meeting.channelCallValue")} icon={<Hash size={13} />} />}
          {call.series && (
            <Fact
              label={t("detail.overview.meeting.repeats")}
              value={describeRecurrence(t, call.series.recurrence)}
              icon={<Repeat size={13} />}
            />
          )}
          {call.channelIds.length > 0 && <MeetingChannelsFact channelIds={call.channelIds} />}
        </dl>
        {call.recordingStatus === "READY" && <RecordingLink callId={call.id} />}
        {call.recordingStatus === "RECORDING" && (
          // Said plainly, for the same reason the external badge is: being
          // recorded is not something anyone should have to work out for
          // themselves, or find out afterwards.
          <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-danger">
            <Disc size={13} className="shrink-0 animate-pulse" />
            {t("detail.overview.meeting.beingRecorded")}
          </p>
        )}
        {/* Handing out the join link — hosts of a live or scheduled meeting
            only, exactly as the server decides. */}
        <div className="mt-3">
          <MeetingInviteLink call={call} />
        </div>
        {call.activeShares[0] && (
          <p className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-fg">
            <ScreenShare size={13} />
            {call.activeShares.length === 1
              ? t("detail.overview.meeting.sharingOne", { name: nameOf(call.activeShares[0].userId) })
              : t("detail.overview.meeting.sharingMany", { count: call.activeShares.length })}
          </p>
        )}
      </section>
    </div>
  );
}

/** What this person actually did about the meeting, in one line. Three real
 *  states, not two: in the room, been and gone, and never turned up — plus the
 *  lobby, which is "here, but the call has not been opened". */
function attendanceOf(p: CallDTO["participants"][number], call: CallDTO, t: TFunction): string {
  if (p.joinedAt && p.leftAt) {
    return t("detail.overview.people.attendance.joinedAndLeft", {
      joinedAt: timeLabel(new Date(p.joinedAt).getTime()),
      leftAt: timeLabel(new Date(p.leftAt).getTime()),
    });
  }
  if (p.joinedAt) {
    return t("detail.overview.people.attendance.joined", {
      joinedAt: timeLabel(new Date(p.joinedAt).getTime()),
    });
  }
  if (p.waitingSince) return t("detail.overview.people.attendance.waiting");
  return call.status === "SCHEDULED"
    ? t("detail.overview.people.attendance.invited")
    : t("detail.overview.people.attendance.didNotJoin");
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{children}</h3>
  );
}

function Fact({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="flex items-center gap-1.5 truncate text-sm font-medium text-fg">
        {icon}
        {value}
      </dd>
    </div>
  );
}

/** The channels a meeting was addressed to, by name. A channel the viewer is not
 *  in is not in their channel list, so it cannot be named — counted instead, which
 *  says it exists without pretending to know what it is called. */
function MeetingChannelsFact({ channelIds }: { channelIds: string[] }) {
  const { t } = useTranslation("meetings");
  const { api } = useRuntime();
  const { data: channels } = useQuery({ queryKey: qk.channels, queryFn: () => api.channels() });
  const byId = new Map((channels ?? []).map((c) => [c.id, c.name]));
  const named = channelIds.flatMap((id) => (byId.has(id) ? [`#${byId.get(id)}`] : []));
  const rest = channelIds.length - named.length;
  const value = [
    ...named,
    ...(rest > 0 ? [t("detail.overview.meeting.channelsUnavailable", { count: rest })] : []),
  ].join(", ");
  return <Fact label={t("detail.overview.meeting.channels")} value={value} icon={<Hash size={13} />} />;
}

/**
 * The recording, if there is one to play.
 *
 * The link is minted on demand and EXPIRES (MEDIA_URL_TTL_SECONDS), which is
 * why it is fetched here rather than carried on the call row — see
 * ApiClient.callRecording.
 */
function RecordingLink({ callId }: { callId: string }) {
  const { t } = useTranslation("meetings");
  const { api } = useRuntime();
  const { data, isLoading } = useQuery({
    queryKey: qk.callRecording(callId),
    queryFn: () => api.callRecording(callId),
  });
  if (isLoading) return <p className="mt-3 text-xs text-muted">{t("detail.recording.preparing")}</p>;
  if (!data?.url) return null;
  return (
    <a
      href={data.url}
      target="_blank"
      rel="noreferrer"
      className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs font-semibold text-fg transition-colors hover:bg-accent-soft hover:text-accent"
    >
      <PlayCircle size={14} /> {t("detail.recording.watch")}
    </a>
  );
}
