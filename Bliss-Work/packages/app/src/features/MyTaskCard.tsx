import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, MessageSquarePlus, Star, UserMinus } from "lucide-react";
import { Avatar, Badge, Button, GlassCard, IconButton } from "@taskboard/ui";
import type { TaskParticipantDTO } from "@taskboard/shared";
import { isMemberReassignable, isReassignableTask, type SentAssignee, type SentTaskMatch } from "../lib/sentTaskFilter";
import { summarizeSentTask, type SentTaskSummaryKind } from "../lib/sentTaskSummary";
import type { ParticipantTargets } from "./AddParticipantsPicker";
import { ReassignMemberButton } from "./ReassignMemberButton";
import { ReassignTaskButton } from "./ReassignTaskButton";
import { isActive, TaskParticipantAdd } from "./TaskParticipants";
import { TaskTimes } from "./TaskTimes";

/** People drawn in the avatar stack before the rest fold into "+N". */
const AVATAR_LIMIT = 4;

type Tone = "success" | "accent" | "danger" | "neutral";
const statusTone = (s: string): Tone =>
  s === "COMPLETED" ? "success" : s === "ACKNOWLEDGED" ? "accent" : s === "IGNORED" || s === "LEFT" || s === "MISSED" ? "danger" : "neutral";

const SUMMARY_TONE: Record<SentTaskSummaryKind, Tone> = {
  pending: "neutral", inProgress: "accent", completed: "success", left: "danger", ignored: "danger", missed: "danger", closed: "neutral",
};
/** The card's left edge, in the same tone as its status badge. */
const ACCENT_BAR: Record<Tone, string> = {
  success: "bg-success", accent: "bg-accent", danger: "bg-danger", neutral: "bg-border",
};

/** Format an ISO instant to the viewer's local date + time (or "" when absent).
 *  `lang` is the in-app selected locale (i18n.language) so this follows the
 *  language switcher rather than only the browser's own locale. */
function fmtTs(iso?: string | null, lang?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(lang, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** The earliest allocation among the rows shown — when the task first went out. */
function firstAssignedAt(assignees: readonly SentAssignee[]): string | null {
  const times = assignees.map((a) => a.assignedAt).filter((v): v is string => !!v && !Number.isNaN(Date.parse(v)));
  return times.length ? times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
}

/**
 * One task on the My tasks board, in a single horizontal band: the task on the
 * left, who it is with in the middle, when and how it stands on the right.
 * Everything per-person (participants with Add / Withdraw, each assignee's
 * timeline and review) sits in a Details panel under the band, so every card is
 * the same short height until it is opened. Reassign stays in the band: it is
 * the one action a finished, left, or ignored task is for.
 */
export function MyTaskCard({
  match: { task, assignees },
  currentUserId,
  nameOf,
  avatarUrlOf,
  onReview,
  onAdd,
  onWithdraw,
}: {
  match: SentTaskMatch;
  currentUserId: string;
  nameOf: (id: string, fallback?: string) => string;
  avatarUrlOf: (id: string) => string | null | undefined;
  onReview: (assignee: SentAssignee) => void;
  onAdd: (taskId: string, targets: ParticipantTargets) => Promise<void>;
  onWithdraw: (taskId: string, userId: string) => Promise<void>;
}) {
  const { t } = useTranslation("tasks");
  const [open, setOpen] = useState(false);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const panelId = useId();
  const summary = summarizeSentTask(assignees);
  const tone = SUMMARY_TONE[summary.kind];
  const participants = task.participants?.length
    ? task.participants
    : assignees.map((a) => ({ userId: a.assigneeId, username: a.assigneeUsername, status: a.status }));
  const named = participants.map((p) => ({ id: p.userId, name: nameOf(p.userId, p.username) }));
  const names = named.map((p) => p.name);
  const extra = named.length - AVATAR_LIMIT;
  // The allocator viewing their own sent task always qualifies (allocatorId
  // is always currentUserId below), so Add/Withdraw are gated only on there
  // being an open assignment to act on — same rule TaskParticipants applies.
  const hasOpenAssignment = participants.some(isActive);
  const removable = (participant: TaskParticipantDTO) => participant.userId !== currentUserId && isActive(participant);
  // Fire-and-forget from onClick: the caller's mutation already reports its own
  // failure (the onError toast), so a rejection here would otherwise be unhandled.
  const withdraw = async (userId: string) => {
    setWithdrawingId(userId);
    try {
      await onWithdraw(task.taskId, userId);
    } catch {
      // Reported by the caller; the row re-enables below so it can be retried.
    } finally {
      setWithdrawingId(null);
    }
  };

  return (
    <GlassCard data-testid="task-card" className="relative min-w-0 overflow-hidden">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${ACCENT_BAR[tone]}`} />
      <div className="grid items-center gap-x-6 gap-y-3 py-3 pl-5 pr-4 md:grid-cols-[minmax(0,1fr)_auto] xl:grid-cols-[minmax(0,1fr)_10rem_minmax(14rem,18rem)]">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 line-clamp-1 break-words font-semibold text-fg">{task.title}</div>
            {hasOpenAssignment && (
              <TaskParticipantAdd participants={participants} onAdd={(targets) => onAdd(task.taskId, targets)} prominent />
            )}
          </div>
          {task.description && <p className="mt-0.5 line-clamp-2 min-w-0 break-words text-sm text-muted">{task.description}</p>}
        </div>

        <div className="flex min-w-0 items-center md:order-3 xl:order-none" title={names.join(", ")}>
          <div className="flex -space-x-1" role="img" aria-label={names.join(", ")}>
            {named.slice(0, AVATAR_LIMIT).map((p) => (
              <Avatar key={p.id} name={p.name} src={avatarUrlOf(p.id)} size="sm" />
            ))}
          </div>
          {extra > 0 && <span className="ml-2 text-xs font-medium text-muted">+{extra}</span>}
        </div>

        <div className="flex min-w-0 flex-col gap-2 md:items-end xl:items-stretch">
          <div className="flex items-center gap-2">
            <Badge tone={tone}>{t(`myTasksBoard.summary.${summary.kind}`)}</Badge>
            {summary.total > 1 && summary.kind !== "completed" && (
              <span className="text-xs text-muted">{t("myTasksBoard.summary.doneOf", { done: summary.done, total: summary.total })}</span>
            )}
            {/* Judged on the task's own rows, not the filtered `assignees`. */}
            {isReassignableTask(task) && <ReassignTaskButton taskId={task.taskId} className="ml-auto h-7" />}
            <IconButton
              className={`h-7 w-7 ${isReassignableTask(task) ? "" : "ml-auto"}`}
              title={t("myTasksBoard.details")}
              aria-label={t("myTasksBoard.details")}
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen(!open)}
            >
              <ChevronDown size={16} className={`transition-transform ${open ? "rotate-180" : ""}`} />
            </IconButton>
          </div>
          {/* Only a task that has a deadline shows one; per-person times are in Details. */}
          <TaskTimes assignedAt={firstAssignedAt(assignees)} deadlineAt={task.deadlineAt} />
        </div>
      </div>

      {open && (
        <div id={panelId} className="border-t border-border/50 py-3 pl-5 pr-4">
          <ul className="flex min-w-0 flex-col divide-y divide-border/50">
            {participants.map((participant) => (
              <ParticipantRow
                key={participant.userId}
                taskId={task.taskId}
                participant={participant}
                assignee={assignees.find((a) => a.assigneeId === participant.userId)}
                name={nameOf(participant.userId, participant.username)}
                avatarUrl={avatarUrlOf(participant.userId)}
                removable={removable(participant)}
                busy={withdrawingId === participant.userId}
                onWithdraw={() => void withdraw(participant.userId)}
                onReview={onReview}
                // Once the whole task is reassignable, the task-wide button above
                // already covers this row (and every other terminal one) in one
                // call; a per-row control here would be a redundant second way to
                // do the identical thing.
                showMemberReassign={!isReassignableTask(task)}
              />
            ))}
          </ul>
        </div>
      )}
    </GlassCard>
  );
}

/**
 * One participant per row: avatar, name, their live status, the full
 * milestone timeline and review the allocator left (when this participant
 * has a matching assignee record), and Withdraw where permitted. Replaces the
 * old side-by-side participants/timeline columns, which listed the same
 * person twice.
 */
function ParticipantRow({
  taskId,
  participant,
  assignee,
  name,
  avatarUrl,
  removable,
  busy,
  onWithdraw,
  onReview,
  showMemberReassign,
}: {
  taskId: string;
  participant: TaskParticipantDTO;
  assignee?: SentAssignee;
  name: string;
  avatarUrl?: string | null;
  removable: boolean;
  busy: boolean;
  onWithdraw: () => void;
  onReview: (assignee: SentAssignee) => void;
  showMemberReassign: boolean;
}) {
  const { t, i18n } = useTranslation("tasks");
  const status = assignee?.status ?? participant.status;
  const milestones = assignee
    ? [
        { label: t("myTasksBoard.milestones.allocated"), at: assignee.assignedAt },
        { label: t("myTasksBoard.milestones.acknowledged"), at: assignee.acknowledgedAt },
        { label: t("myTasksBoard.milestones.ignored"), at: assignee.ignoredAt },
        { label: t("myTasksBoard.milestones.completed"), at: assignee.completedAt },
        { label: t("myTasksBoard.milestones.left"), at: assignee.leftAt },
        { label: t("myTasksBoard.milestones.missed"), at: assignee.missedAt },
        { label: t("myTasksBoard.milestones.reviewed"), at: assignee.reviewedAt },
      ].filter((m) => m.at)
    : [];

  return (
    <li className="flex min-w-0 flex-col gap-1.5 py-2 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="inline-flex min-w-[min(10rem,100%)] max-w-full flex-1 items-center gap-2 text-sm font-medium text-fg">
          <Avatar name={name} src={avatarUrl} size="sm" />
          <span className="min-w-0 truncate">{name}</span>
          <Badge tone={statusTone(status)} className="min-w-0 max-w-full">
            <span className="truncate">{status.toLowerCase()}</span>
          </Badge>
        </span>
        <div className="flex items-center gap-2">
          {assignee && assignee.status === "COMPLETED" && (
            <Button variant="ghost" size="sm" className="max-w-full" onClick={() => onReview(assignee)}>
              <MessageSquarePlus size={14} /> {assignee.review ? t("myTasksBoard.review.edit") : t("myTasksBoard.review.write")}
            </Button>
          )}
          {/* Judged on this one row, never the task as a whole — see `isMemberReassignable`. */}
          {showMemberReassign && assignee && isMemberReassignable(assignee.status) && (
            <ReassignMemberButton taskId={taskId} userId={assignee.assigneeId} name={name} className="max-w-full" />
          )}
          {removable && (
            <Button
              variant="secondary"
              size="sm"
              className="max-w-full text-danger"
              aria-label={t("participants.withdrawUser", { name })}
              disabled={busy}
              onClick={onWithdraw}
            >
              {/* Visible text is just "Withdraw" (per-row identity already comes from the
                  avatar + name to its left); the aria-label keeps each row distinguishable
                  for a screen reader tabbing straight to the button. */}
              <UserMinus size={14} className="shrink-0" />
              <span className="min-w-0 truncate">{t("participants.withdraw")}</span>
            </Button>
          )}
        </div>
      </div>
      {milestones.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          {milestones.map((m) => (
            <span key={m.label}>
              <span className="text-fg/70">{m.label}</span> {fmtTs(m.at, i18n.language)}
            </span>
          ))}
        </div>
      )}
      {assignee?.review && (
        <div className="rounded-lg bg-surface-2/60 p-2.5 text-sm">
          {assignee.reviewRating != null && (
            <div className="mb-1 flex items-center gap-0.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <Star key={n} size={14} className={n <= assignee.reviewRating! ? "fill-amber-400 text-amber-400" : "text-muted/40"} />
              ))}
            </div>
          )}
          <p className="whitespace-pre-wrap text-muted">{assignee.review}</p>
        </div>
      )}
    </li>
  );
}
