/**
 * "New task" modal.
 *
 * Who it goes to is a People group and a Channels group, shown together
 * (MeetingAudienceFields, the same control the meeting form uses); either, or
 * both, may be filled. One Create is one request and one task: task-svc takes
 * `assigneeIds` and `channelIds` together, resolves each channel's members, and
 * keeps the channels attached to the task so a later joiner is added too.
 *
 * Locked channels appear here only if the caller is a member; open channels they
 * aren't in are intentionally excluded — the assigner has to join first.
 */
import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CalendarClock, Repeat, Zap, type LucideIcon } from "lucide-react";
import { Button, Input, Textarea } from "@taskboard/ui";
import { toast } from "sonner";
import type { UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { dayLabel, timeLabel } from "../lib/meetingTime";
import { localDateTimeWithOffset } from "../lib/taskDates";
import { deadlineProblem, deadlineRequest, emptyDeadline, type Allocation, type DeadlineForm, type DeadlineProblem } from "../lib/taskDeadline";
import { Modal } from "./Modal";
import { Field } from "../routes/Onboarding";
import { MeetingAudienceFields, type AudienceCopy } from "./MeetingAudienceFields";
import { TaskDeadlineField } from "./TaskDeadlineField";
import { TimePicker } from "./TimePicker";


type Frequency = "DAILY" | "WEEKLY" | "MONTHLY";
type EndCondition = "NO_END" | "AFTER_OCCURRENCES" | "ON_DATE";

const DEADLINE_ERRORS: Record<DeadlineProblem, string> = {
  needAt: "createTaskDialog.errors.needDeadlineAt",
  notFuture: "createTaskDialog.errors.deadlineNotFuture",
  beforeStart: "createTaskDialog.errors.deadlineBeforeStart",
  amount: "createTaskDialog.errors.invalidDeadlineAmount",
  needFixedTime: "createTaskDialog.errors.needDeadlineTime",
  fixedBeforeStart: "createTaskDialog.errors.fixedDeadlineBeforeStart",
};

const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

export function CreateTaskDialog({
  open,
  onClose,
  preselect = [],
}: {
  open: boolean;
  onClose: () => void;
  preselect?: UserDTO[];
}) {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedPeople, setSelectedPeople] = useState<Set<string>>(new Set());
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set());
  const [allocation, setAllocation] = useState<Allocation>("NOW");
  const [scheduledDate, setScheduledDate] = useState("");
  const [scheduledTime, setScheduledTime] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("DAILY");
  const [recurrenceInterval, setRecurrenceInterval] = useState("1");
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set([0]));
  const [monthlyRule, setMonthlyRule] = useState<"DAY_OF_MONTH" | "WEEKDAY_PATTERN">("DAY_OF_MONTH");
  const [monthlyDay, setMonthlyDay] = useState("1");
  const [monthlyOrdinal, setMonthlyOrdinal] = useState("1");
  const [monthlyWeekday, setMonthlyWeekday] = useState("1");
  const [endCondition, setEndCondition] = useState<EndCondition>("NO_END");
  const [endDate, setEndDate] = useState("");
  const [occurrenceCount, setOccurrenceCount] = useState("1");
  const [deadline, setDeadline] = useState<DeadlineForm>(emptyDeadline);

  const { data: channels = [] } = useQuery({
    queryKey: qk.channels,
    queryFn: () => api.channels(),
    enabled: open,
  });

  // "Schedule for later"'s small allocation summary — who, and the real
  // combined start moment (same localDateTimeWithOffset the request itself
  // is built from, so the summary can never say something the request doesn't).
  const summaryTargets = [
    ...(selectedPeople.size > 0 ? [t("createTaskDialog.allocation.peopleCount", { count: selectedPeople.size })] : []),
    ...channels.filter((c) => selectedChannels.has(c.id)).map((c) => `#${c.name}`),
  ];
  const summaryWho = summaryTargets.length > 0 ? summaryTargets.join(", ") : t("createTaskDialog.allocation.noTargetYet");
  const summaryStartIso = localDateTimeWithOffset(scheduledDate, scheduledTime);
  const summaryWhen = summaryStartIso
    ? `${dayLabel(new Date(summaryStartIso).getTime())} · ${timeLabel(new Date(summaryStartIso).getTime())}`
    : null;

  const assignToId = useId();
  const formId = useId();
  const audienceCopy: AudienceCopy = {
    peopleLabel: t("createTaskDialog.fields.peopleLabel"),
    peopleNone: t("createTaskDialog.fields.assignToEmpty"),
    peopleAdd: t("createTaskDialog.fields.addPeople"),
    peopleDone: t("createTaskDialog.fields.done"),
    peopleRemove: (name) => t("createTaskDialog.fields.removePerson", { name }),
    unknownPerson: t("createTaskDialog.fields.unknownPerson"),
    you: t("createTaskDialog.fields.you"),
    channelsLabel: t("createTaskDialog.fields.channelsLabel"),
    channelsHint: t("createTaskDialog.fields.channelHint"),
    channelsNone: t("createTaskDialog.fields.assignToChannelEmpty"),
    channelsAdd: t("createTaskDialog.fields.addChannels"),
    channelsDone: t("createTaskDialog.fields.done"),
    channelsRemove: (name) => t("createTaskDialog.fields.removeChannel", { name }),
    unknownChannel: t("createTaskDialog.fields.unknownChannel"),
  };

  useEffect(() => {
    if (open) {
      setSelectedPeople(new Set(preselect.map((u) => u.id)));
      setSelectedChannels(new Set());
      setAllocation("NOW");
      setScheduledDate("");
      setScheduledTime("");
      setFrequency("DAILY");
      setRecurrenceInterval("1");
      setWeekdays(new Set([0]));
      setMonthlyRule("DAY_OF_MONTH");
      setMonthlyDay("1");
      setMonthlyOrdinal("1");
      setMonthlyWeekday("1");
      setEndCondition("NO_END");
      setEndDate("");
      setOccurrenceCount("1");
      setDeadline(emptyDeadline());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A deadline is optional: with none, the request is exactly what it always was.
  const { deadlineAt, recurrenceDeadline } = deadlineRequest(deadline, allocation);

  const create = useMutation({
    // ONE request for the whole selection, whatever mix of people and channels it
    // is. task-svc resolves each channel's members (so someone both picked and in a
    // picked channel is still one recipient) and keeps the channels attached to the
    // task, so a member who joins one later is added to it.
    mutationFn: () =>
      api.createTask({
        title,
        description,
        allocation,
        ...(selectedPeople.size > 0 ? { assigneeIds: [...selectedPeople] } : {}),
        ...(selectedChannels.size > 0 ? { channelIds: [...selectedChannels] } : {}),
        ...(allocation === "SCHEDULED" ? { scheduledFor: localDateTimeWithOffset(scheduledDate, scheduledTime)! } : {}),
        ...(allocation === "RECURRING" ? { recurrence: recurrencePayload() } : {}),
        ...(deadlineAt ? { deadlineAt } : {}),
      }),
    onSuccess: () => {
      // Only a lone channel gets the channel-specific toast: with people (or other
      // channels) alongside it, "sent to #general — 12 members" would undercount.
      const lone =
        selectedPeople.size === 0 && selectedChannels.size === 1
          ? channels.find((c) => selectedChannels.has(c.id))
          : undefined;
      toast.success(
        lone
          ? t("createTaskDialog.toasts.sentToChannel", {
              channelName: lone.name,
              // The dialog uses the snapshot count for the success toast only —
              // server is the source of truth.
              count: lone.memberCount,
            })
          : allocation === "NOW"
            ? t("createTaskDialog.toasts.sentPlain")
            : t("createTaskDialog.toasts.scheduled"),
      );
      qc.invalidateQueries({ queryKey: qk.sent });
      // Self-assignment also makes the new task appear in Allocated to me.
      // Keep this mutation-owned cache fresh even if the deduplicated task
      // event arrives before the active view has subscribed to it.
      qc.invalidateQueries({ queryKey: qk.assigned });
      qc.invalidateQueries({ queryKey: qk.unifiedInbox });
      // New SENT rows change the "n pending, unacked" hints in the Available
      // bucket (allocating doesn't make anyone unavailable, but it does queue).
      qc.invalidateQueries({ queryKey: qk.availability });
      setTitle("");
      setDescription("");
      setSelectedPeople(new Set());
      setSelectedChannels(new Set());
      onClose();
    },
    onError: (e) => toast.error(t("createTaskDialog.errors.createFailed"), { description: String(e) }),
  });

  const togglePerson = (id: string) => setSelectedPeople((s) => toggled(s, id));
  const toggleChannel = (id: string) => setSelectedChannels((s) => toggled(s, id));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return toast.error(t("createTaskDialog.errors.needTitle"));
    if (selectedPeople.size === 0 && selectedChannels.size === 0)
      return toast.error(t("createTaskDialog.errors.needAssignee"));
    if (allocation === "SCHEDULED") {
      const at = localDateTimeWithOffset(scheduledDate, scheduledTime);
      if (!at || Date.parse(at) <= Date.now()) return toast.error(t("createTaskDialog.errors.invalidSchedule"));
    }
    if (allocation === "RECURRING") {
      const startAt = localDateTimeWithOffset(scheduledDate, scheduledTime);
      if (!startAt || Date.parse(startAt) <= Date.now()) return toast.error(t("createTaskDialog.errors.invalidStart"));
      if (frequency === "WEEKLY" && weekdays.size === 0) return toast.error(t("createTaskDialog.errors.needWeekday"));
      if (frequency === "MONTHLY" && monthlyRule === "DAY_OF_MONTH" && (+monthlyDay < 1 || +monthlyDay > 31))
        return toast.error(t("createTaskDialog.errors.invalidMonthlyRule"));
      if (endCondition === "AFTER_OCCURRENCES" && +occurrenceCount < 1)
        return toast.error(t("createTaskDialog.errors.invalidOccurrences"));
      if (endCondition === "ON_DATE" && (!endDate || Date.parse(`${endDate}T00:00:00`) <= Date.parse(startAt)))
        return toast.error(t("createTaskDialog.errors.invalidEndDate"));
    }
    const problem = deadlineProblem(deadline, allocation, { date: scheduledDate, time: scheduledTime }, Date.now());
    if (problem) return toast.error(t(DEADLINE_ERRORS[problem]));
    create.mutate();
  };

  const recurrencePayload = () => {
    const startAt = localDateTimeWithOffset(scheduledDate, scheduledTime)!;
    return {
      startAt,
      frequency,
      interval: Math.max(1, Number(recurrenceInterval) || 1),
      ...(frequency === "WEEKLY" ? { weekdays: [...weekdays] } : {}),
      ...(frequency === "MONTHLY"
        ? monthlyRule === "DAY_OF_MONTH"
          ? { monthlyRule, monthlyDay: Number(monthlyDay) }
          : { monthlyRule, monthlyOrdinal: Number(monthlyOrdinal), monthlyWeekday: Number(monthlyWeekday) }
        : {}),
      endCondition,
      ...(endCondition === "ON_DATE" ? { endAt: localDateTimeWithOffset(endDate, scheduledTime)! } : {}),
      ...(endCondition === "AFTER_OCCURRENCES" ? { occurrenceCount: Number(occurrenceCount) } : {}),
      ...(recurrenceDeadline ? { deadline: recurrenceDeadline } : {}),
    } as const;
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("createTaskDialog.title")}
      wide
      showClose
      // Modal's pinned footer sits outside the scrolling body, so the submit
      // button reaches this form through the `form` attribute, not by nesting.
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("createTaskDialog.actions.cancel")}
          </Button>
          <Button type="submit" form={formId} loading={create.isPending}>
            {create.isPending ? t("createTaskDialog.actions.creating") : t("createTaskDialog.actions.create")}
          </Button>
        </div>
      }
    >
      <form id={formId} onSubmit={submit} className="grid gap-x-6 gap-y-3.5 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        {/* LEFT: what the task is and who gets it. */}
        <div className="flex min-w-0 flex-col gap-3.5">
          <Field label={t("createTaskDialog.fields.title")}>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={200}
              placeholder={t("createTaskDialog.fields.titlePlaceholder")}
            />
          </Field>
          <Field label={t("createTaskDialog.fields.description")}>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="min-h-[4.5rem]"
              placeholder={t("createTaskDialog.fields.descriptionPlaceholder")}
            />
          </Field>

          <div role="group" aria-labelledby={assignToId} className="flex flex-col gap-2.5">
            <span id={assignToId} className="text-sm font-medium text-fg">
              {t("createTaskDialog.fields.assignTo")}
            </span>
            {/* includeSelf: task assignment allows sending a task to yourself, same as
                fanning one to a channel you are a member of (see task-svc's create_task). */}
            <MeetingAudienceFields
              tone="theme"
              includeSelf
              invitees={selectedPeople}
              onToggleInvitee={togglePerson}
              channels={selectedChannels}
              onToggleChannel={toggleChannel}
              copy={audienceCopy}
            />
          </div>
        </div>

        {/* RIGHT: when it is allocated — the selected mode decides which of
            start / repeat / deadline appear. */}
        <div className="flex min-w-0 flex-col gap-3 md:border-l md:border-border/60 md:pl-6">
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-fg/80">{t("createTaskDialog.allocation.title")}</span>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <AllocationCard
                name="allocation"
                checked={allocation === "NOW"}
                onChange={() => setAllocation("NOW")}
                icon={Zap}
                title={t("createTaskDialog.allocation.now")}
                description={t("createTaskDialog.allocation.nowDescription")}
              />
              <AllocationCard
                name="allocation"
                checked={allocation === "SCHEDULED"}
                onChange={() => setAllocation("SCHEDULED")}
                icon={CalendarClock}
                title={t("createTaskDialog.allocation.scheduled")}
                description={t("createTaskDialog.allocation.scheduledDescription")}
              />
              <AllocationCard
                name="allocation"
                checked={allocation === "RECURRING"}
                onChange={() => setAllocation("RECURRING")}
                icon={Repeat}
                title={t("createTaskDialog.allocation.recurring")}
                description={t("createTaskDialog.allocation.recurringDescription")}
              />
            </div>
            {allocation !== "NOW" && (
              <div className="mt-2 flex flex-col gap-2.5 rounded-xl border border-border/60 p-2.5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t("createTaskDialog.allocation.startDate")}>
                    <Input type="date" value={scheduledDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setScheduledDate(e.target.value)} required className="h-9" />
                  </Field>
                  <Field label={t("createTaskDialog.allocation.startTime")}>
                    <TimePicker
                      tone="theme"
                      label={t("createTaskDialog.allocation.startTime")}
                      value={scheduledTime}
                      onChange={setScheduledTime}
                    />
                  </Field>
                </div>
                {allocation === "SCHEDULED" && summaryWhen && (
                  <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
                    {t("createTaskDialog.allocation.summary", { who: summaryWho, when: summaryWhen })}
                  </p>
                )}
                {allocation === "RECURRING" && (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mr-1 text-[13px] font-medium text-fg/80">{t("createTaskDialog.allocation.repeat")}</span>
                      {(["DAILY", "WEEKLY", "MONTHLY"] as const).map((kind) => (
                        <ModeTab key={kind} active={frequency === kind} onClick={() => setFrequency(kind)}>
                          {t(`createTaskDialog.allocation.${kind.toLowerCase()}`)}
                        </ModeTab>
                      ))}
                    </div>
                    <label className="flex items-center gap-2 text-sm text-fg">
                      {t(`createTaskDialog.allocation.every${frequency === "DAILY" ? "Day" : frequency === "WEEKLY" ? "Week" : "Month"}`)}
                      <Input className="h-9 w-20" type="number" min={1} value={recurrenceInterval} onChange={(e) => setRecurrenceInterval(e.target.value)} />
                    </label>
                    {frequency === "WEEKLY" && (
                      <div className="flex flex-wrap gap-1.5">
                        {weekdayLabels.map((label, day) => (
                          <button key={label} type="button" onClick={() => setWeekdays((current) => toggled(current, day))} className={`rounded-full px-2.5 py-1 text-xs ${weekdays.has(day) ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted"}`}>
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                    {frequency === "MONTHLY" && (
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <select className="rounded-lg border border-border bg-surface px-2 py-1.5" value={monthlyRule} onChange={(e) => setMonthlyRule(e.target.value as typeof monthlyRule)}>
                          <option value="DAY_OF_MONTH">Day of month</option>
                          <option value="WEEKDAY_PATTERN">Weekday pattern</option>
                        </select>
                        {monthlyRule === "DAY_OF_MONTH" ? (
                          <Input className="h-9 w-20" type="number" min={1} max={31} value={monthlyDay} onChange={(e) => setMonthlyDay(e.target.value)} />
                        ) : (
                          <>
                            <select className="rounded-lg border border-border bg-surface px-2 py-1.5" value={monthlyOrdinal} onChange={(e) => setMonthlyOrdinal(e.target.value)}>
                              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{["First", "Second", "Third", "Fourth", "Fifth"][n - 1]}</option>)}
                            </select>
                            <select className="rounded-lg border border-border bg-surface px-2 py-1.5" value={monthlyWeekday} onChange={(e) => setMonthlyWeekday(e.target.value)}>
                              {weekdayLabels.map((label, day) => <option key={label} value={day}>{label}</option>)}
                            </select>
                          </>
                        )}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-[13px]">
                      {(["NO_END", "AFTER_OCCURRENCES", "ON_DATE"] as const).map((kind) => (
                        <label key={kind} className="inline-flex items-center gap-1.5 text-fg">
                          <input type="radio" name="endCondition" checked={endCondition === kind} onChange={() => setEndCondition(kind)} />
                          {t(`createTaskDialog.allocation.${kind === "NO_END" ? "noEnd" : kind === "AFTER_OCCURRENCES" ? "afterOccurrences" : "onDate"}`)}
                        </label>
                      ))}
                    </div>
                    {endCondition === "AFTER_OCCURRENCES" && <Input className="h-9" type="number" min={1} value={occurrenceCount} onChange={(e) => setOccurrenceCount(e.target.value)} />}
                    {endCondition === "ON_DATE" && <Input className="h-9" type="date" min={scheduledDate} value={endDate} onChange={(e) => setEndDate(e.target.value)} />}
                  </>
                )}
              </div>
            )}
          </div>

          <TaskDeadlineField
            allocation={allocation}
            value={deadline}
            onChange={setDeadline}
            startDate={scheduledDate}
            startTime={scheduledTime}
          />
        </div>
      </form>
    </Modal>
  );
}

function AllocationCard({
  name,
  checked,
  onChange,
  icon: Icon,
  title,
  description,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    // relative + a card-sized (not 1px) invisible radio: the radio is
    // position:absolute, so without a positioned ancestor INSIDE the modal's
    // scrolling body it is placed against the page — it stops scrolling with
    // the form and Tab-focusing it never scrolls the card into view. And a 1px
    // radio counts as "in view" while the card body is still clipped, so the
    // radio covers the whole card and focus scrolls all of it into view.
    <label
      title={description}
      className={`relative flex cursor-pointer flex-col justify-center rounded-xl border p-2 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${
        checked ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-surface-2"
      }`}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="absolute inset-0 m-0 h-full w-full cursor-pointer opacity-0"
      />
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
            checked ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted"
          }`}
        >
          <Icon size={15} aria-hidden />
        </span>
        <span className="min-w-0 text-[13px] font-semibold leading-tight text-fg">{title}</span>
      </span>
    </label>
  );
}

function ModeTab({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-medium transition ${
        active ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}
