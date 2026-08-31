import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Disc, Hash, PlayCircle, ScreenShare, Video } from "lucide-react";
import { Avatar, Badge, Button, Spinner } from "@taskboard/ui";
import type { CallDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { useUserLabels } from "../lib/userLabel";
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
        <Spinner /> Loading…
      </div>
    );
  }
  if (isError || !call) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertCircle size={24} className="text-muted" />
        <div className="text-sm font-medium text-fg">Couldn't open this meeting.</div>
        <Button size="sm" variant="secondary" onClick={() => void refetch()}>
          Retry
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
    { key: "overview", label: "Overview" },
    { key: "chat", label: "Chat" },
    { key: "notes", label: "Notes" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border/60 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold tracking-tight text-fg">{name}</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
              <span>{KIND_LABEL[call.kind]}</span>
              <span aria-hidden>·</span>
              <span>{dayLabel(whenOf(call))}</span>
              {/* The title is shown above; when there ISN'T one the heading is
                  already the people, so this does not repeat them. */}
              {call.title.trim() === "" && <span className="italic">no title set</span>}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <MeetingStatusBadge call={call} />
            {joinable && (
              <Button size="sm" onClick={open}>
                <Video size={15} />
                {bucket === "live" ? "Join" : "Open"}
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

const KIND_LABEL: Record<CallDTO["kind"], string> = {
  MEETING: "Meeting",
  CHANNEL: "Channel call",
  DIRECT: "Call",
};

function MeetingStatusBadge({ call }: { call: CallDTO }) {
  if (call.status === "LIVE") {
    return (
      <Badge tone="success">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> Live
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
  const start = whenOf(call);
  const joined = call.participants.filter((p) => p.joinedAt);

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>When</SectionTitle>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Fact label="Date" value={new Date(start).toLocaleDateString(undefined, {
            weekday: "short", day: "numeric", month: "short", year: "numeric",
          })} />
          <Fact label="Start" value={call.startedAt ? timeLabel(new Date(call.startedAt).getTime()) : timeLabel(start)} />
          {/* An end only once there IS one. A live meeting has not ended, and a
              scheduled one's planned end is a plan — shown as such. */}
          <Fact
            label={call.endedAt ? "End" : "Scheduled end"}
            value={
              call.endedAt
                ? timeLabel(new Date(call.endedAt).getTime())
                : call.endsAt
                  ? timeLabel(new Date(call.endsAt).getTime())
                  : "—"
            }
          />
          <Fact
            label={call.status === "LIVE" ? "Running for" : "Duration"}
            value={durationLabel(durationMsOf(call))}
          />
        </dl>
      </section>

      <section>
        <SectionTitle>
          People · {joined.length} of {call.participants.length} joined
        </SectionTitle>
        {call.participants.length === 0 ? (
          <p className="text-sm text-muted">No roster was recorded for this meeting.</p>
        ) : (
          <ul className="space-y-1.5">
            {call.participants.map((p) => (
              <li key={p.userId} className="flex items-center gap-2.5">
                <Avatar name={nameOf(p.userId)} src={avatarUrlOf(p.userId)} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-fg">{nameOf(p.userId)}</span>
                    {p.role === "HOST" && <Badge tone="accent">Host</Badge>}
                    {p.external && <Badge tone="warning">External</Badge>}
                  </div>
                  <p className="text-xs text-muted">{attendanceOf(p, call)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionTitle>Meeting</SectionTitle>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Fact label="Organised by" value={nameOf(call.createdBy)} />
          {call.startedBy && call.startedBy !== call.createdBy && (
            <Fact label="Opened by" value={nameOf(call.startedBy)} />
          )}
          <Fact label="Media" value={call.media === "audio" ? "Audio only" : "Video"} />
          <Fact
            label="Recording"
            value={
              call.recordingStatus === "READY"
                ? "Available"
                : call.recordingStatus === "RECORDING"
                  ? "In progress"
                  : "Not recorded"
            }
            icon={call.recordingStatus ? <Disc size={13} /> : undefined}
          />
          {call.channelId && <Fact label="Channel call" value="Roster is the channel" icon={<Hash size={13} />} />}
        </dl>
        {call.recordingStatus === "READY" && <RecordingLink callId={call.id} />}
        {call.recordingStatus === "RECORDING" && (
          // Said plainly, for the same reason the external badge is: being
          // recorded is not something anyone should have to work out for
          // themselves, or find out afterwards.
          <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-danger">
            <Disc size={13} className="shrink-0 animate-pulse" />
            This call is being recorded
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
              ? `${nameOf(call.activeShares[0].userId)} is sharing their screen`
              : `${call.activeShares.length} people are sharing`}
          </p>
        )}
      </section>
    </div>
  );
}

/** What this person actually did about the meeting, in one line. Three real
 *  states, not two: in the room, been and gone, and never turned up — plus the
 *  lobby, which is "here, but the call has not been opened". */
function attendanceOf(p: CallDTO["participants"][number], call: CallDTO): string {
  if (p.joinedAt && p.leftAt) {
    return `Joined ${timeLabel(new Date(p.joinedAt).getTime())} · left ${timeLabel(new Date(p.leftAt).getTime())}`;
  }
  if (p.joinedAt) return `Joined ${timeLabel(new Date(p.joinedAt).getTime())}`;
  if (p.waitingSince) return "Waiting to be let in";
  return call.status === "SCHEDULED" ? "Invited" : "Did not join";
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

/**
 * The recording, if there is one to play.
 *
 * The link is minted on demand and EXPIRES (MEDIA_URL_TTL_SECONDS), which is
 * why it is fetched here rather than carried on the call row — see
 * ApiClient.callRecording.
 */
function RecordingLink({ callId }: { callId: string }) {
  const { api } = useRuntime();
  const { data, isLoading } = useQuery({
    queryKey: qk.callRecording(callId),
    queryFn: () => api.callRecording(callId),
  });
  if (isLoading) return <p className="mt-3 text-xs text-muted">Preparing playback…</p>;
  if (!data?.url) return null;
  return (
    <a
      href={data.url}
      target="_blank"
      rel="noreferrer"
      className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs font-semibold text-fg transition-colors hover:bg-accent-soft hover:text-accent"
    >
      <PlayCircle size={14} /> Watch the recording
    </a>
  );
}
