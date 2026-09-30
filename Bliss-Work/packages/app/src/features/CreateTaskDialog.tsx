/**
 * "New task" modal.
 *
 * Two assignment modes — picked via a small tab at the top:
 *
 *   • People    — choose one or more teammates by name. (Original behaviour.)
 *   • Channel   — choose a single channel; on submit we expand the channel
 *                 into its current member ids and create one multi-assignee
 *                 task. Every member receives the task in their inbox and a
 *                 sticky note pops up on their screen exactly the same as
 *                 a personally-allocated task. (Same flow per the product
 *                 requirement.)
 *
 * Channel mode requires fetching member ids at submit time so a member who
 * joined since the dialog opened still receives the task. Locked channels
 * appear here only if the caller is a member; open channels they aren't in
 * are intentionally excluded — the assigner has to join first.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CalendarClock, Check, Hash, Lock, Repeat, Search, Users, Zap, type LucideIcon } from "lucide-react";
import { Avatar, Button, Input, Textarea } from "@taskboard/ui";
import { toast } from "sonner";
import type { ChannelDTO, UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { usePeopleSearch } from "../lib/usePeopleCandidates";
import { dayLabel, timeLabel } from "../lib/meetingTime";
import { Modal } from "./Modal";
import { Field } from "../routes/Onboarding";
import { SelectionField, type SelectionChip } from "./SelectionField";
import { TimePicker } from "./TimePicker";

type Mode = "people" | "channel";
type Allocation = "NOW" | "SCHEDULED" | "RECURRING";
type Frequency = "DAILY" | "WEEKLY" | "MONTHLY";
type EndCondition = "NO_END" | "AFTER_OCCURRENCES" | "ON_DATE";

const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

function localDateTimeWithOffset(date: string, time: string): string | null {
  const value = new Date(`${date}T${time}`);
  if (Number.isNaN(value.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -value.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const minutes = Math.abs(offset);
  return `${date}T${time}:00${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
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
  const [mode, setMode] = useState<Mode>("people");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedPeople, setSelectedPeople] = useState<Set<string>>(new Set());
  const [selectedChannel, setSelectedChannel] = useState<string>("");
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

  // includeSelf: the People tab allows sending a task to yourself, same as
  // channel mode already allows fanning a task to a channel you're a member
  // of (see task-svc's create_task).
  const { q, setQ, all, candidates, me } = usePeopleSearch(undefined, true);
  const { data: channels = [] } = useQuery({
    queryKey: qk.channels,
    queryFn: () => api.channels(),
    enabled: open,
  });
  const selectedChannelObj = channels.find((c) => c.id === selectedChannel);

  // Chips for the People/Channel SelectionFields below. Built from `all` (the
  // UNFILTERED directory/channel list), not `candidates`/`shown` — those are
  // search-filtered, so a person or channel picked before the query narrowed
  // them out would otherwise vanish from its own chip.
  const memberChips: SelectionChip[] = useMemo(() => {
    const byId = new Map(all.map((u) => [u.id, u]));
    return [...selectedPeople].map((id) => {
      const u = byId.get(id);
      const label = u?.displayName ?? t("createTaskDialog.fields.unknownPerson");
      return {
        id,
        label: id === me.id ? `${label} ${t("createTaskDialog.fields.you")}` : label,
        leading: (
          <span aria-hidden="true" className="flex">
            <Avatar name={label} src={u?.avatarUrl} size="sm" />
          </span>
        ),
      };
    });
  }, [selectedPeople, all, me.id, t]);
  const channelChips: SelectionChip[] = selectedChannelObj
    ? [
        {
          id: selectedChannelObj.id,
          label: selectedChannelObj.name,
          leading: <Hash size={13} className="ml-1 shrink-0 text-muted" aria-hidden />,
        },
      ]
    : [];

  // "Schedule for later"'s small allocation summary — who, and the real
  // combined start moment (same localDateTimeWithOffset the request itself
  // is built from, so the summary can never say something the request doesn't).
  const summaryWho =
    mode === "channel"
      ? selectedChannelObj
        ? `#${selectedChannelObj.name}`
        : t("createTaskDialog.allocation.noTargetYet")
      : t("createTaskDialog.allocation.peopleCount", { count: selectedPeople.size });
  const summaryStartIso = localDateTimeWithOffset(scheduledDate, scheduledTime);
  const summaryWhen = summaryStartIso
    ? `${dayLabel(new Date(summaryStartIso).getTime())} · ${timeLabel(new Date(summaryStartIso).getTime())}`
    : null;

  useEffect(() => {
    if (open) {
      setMode("people");
      setSelectedPeople(new Set(preselect.map((u) => u.id)));
      setSelectedChannel("");
      setQ("");
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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const create = useMutation({
    mutationFn: async (): Promise<{ taskId: string; assigneeCount: number }> => {
      const common = { title, description, allocation } as const;
      if (mode === "channel") {
        if (!selectedChannel) throw new Error(t("createTaskDialog.errors.pickChannel"));
        // Send the channelId — task-svc resolves the membership server-side
        // and persists tasks.channel_id so a member who joins later is
        // auto-added by the ChannelMemberJoined consumer.
        const res = await api.createTask({
          ...common,
          channelId: selectedChannel,
          ...(allocation === "SCHEDULED" ? { scheduledFor: localDateTimeWithOffset(scheduledDate, scheduledTime)! } : {}),
          ...(allocation === "RECURRING" ? { recurrence: recurrencePayload() } : {}),
        });
        // The dialog uses the snapshot count for the success toast only —
        // server is the source of truth.
        const ch = channels.find((c) => c.id === selectedChannel);
        return { ...res, assigneeCount: ch?.memberCount ?? 0 };
      }
      const ids = [...selectedPeople];
      const res = await api.createTask({
        ...common,
        assigneeIds: ids,
        ...(allocation === "SCHEDULED" ? { scheduledFor: localDateTimeWithOffset(scheduledDate, scheduledTime)! } : {}),
        ...(allocation === "RECURRING" ? { recurrence: recurrencePayload() } : {}),
      });
      return { ...res, assigneeCount: ids.length };
    },
    onSuccess: ({ assigneeCount }) => {
      const channel = channels.find((c) => c.id === selectedChannel);
      toast.success(
        mode === "channel"
          ? t("createTaskDialog.toasts.sentToChannel", {
              channelName: channel?.name ?? t("createTaskDialog.toasts.genericChannelFallback"),
              count: assigneeCount,
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
      setSelectedChannel("");
      onClose();
    },
    onError: (e) => toast.error(t("createTaskDialog.errors.createFailed"), { description: String(e) }),
  });

  const togglePerson = (id: string) =>
    setSelectedPeople((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return toast.error(t("createTaskDialog.errors.needTitle"));
    if (mode === "people" && selectedPeople.size === 0)
      return toast.error(t("createTaskDialog.errors.needAssignee"));
    if (mode === "channel" && !selectedChannel) return toast.error(t("createTaskDialog.errors.pickChannel"));
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
    } as const;
  };

  return (
    <Modal open={open} onClose={onClose} title={t("createTaskDialog.title")}>
      <form onSubmit={submit} className="flex flex-col gap-3.5">
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
            placeholder={t("createTaskDialog.fields.descriptionPlaceholder")}
          />
        </Field>

        <div className="flex gap-1">
          <ModeTab active={mode === "people"} onClick={() => setMode("people")}>
            <Users size={13} /> {t("createTaskDialog.modes.people")}
          </ModeTab>
          <ModeTab active={mode === "channel"} onClick={() => setMode("channel")}>
            <Hash size={13} /> {t("createTaskDialog.modes.channel")}
          </ModeTab>
        </div>

        {mode === "people" ? (
          <SelectionField
            tone="theme"
            label={t("createTaskDialog.fields.assignTo")}
            chips={memberChips}
            onRemove={togglePerson}
            removeLabel={(chip) => t("createTaskDialog.fields.removePerson", { name: chip.label })}
            emptyLabel={t("createTaskDialog.fields.assignToEmpty")}
            addLabel={t("createTaskDialog.fields.addPeople")}
            doneLabel={t("createTaskDialog.fields.done")}
          >
            <div className="relative mb-2">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
              />
              <Input
                className="h-10 pl-9"
                placeholder={t("createTaskDialog.fields.searchPeoplePlaceholder")}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                autoFocus
              />
            </div>
            <div className="max-h-44 overflow-auto rounded-xl border border-border p-1">
              {candidates.length === 0 && (
                <p className="px-2 py-3 text-sm text-muted">{t("createTaskDialog.fields.noMatches")}</p>
              )}
              {candidates.map((u) => {
                const on = selectedPeople.has(u.id);
                return (
                  <button
                    type="button"
                    key={u.id}
                    onClick={() => togglePerson(u.id)}
                    aria-pressed={on}
                    className={`flex w-full items-center gap-2.5 rounded-lg p-2 text-left ${
                      on ? "bg-accent-soft" : "hover:bg-surface-2"
                    }`}
                  >
                    <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
                    <span className="flex-1 truncate text-sm text-fg">
                      {u.displayName}
                      {u.id === me.id && (
                        <span className="ml-1 text-muted">{t("createTaskDialog.fields.you")}</span>
                      )}
                    </span>
                    {on && <Check size={15} className="text-accent" />}
                  </button>
                );
              })}
            </div>
          </SelectionField>
        ) : (
          <SelectionField
            tone="theme"
            label={t("createTaskDialog.fields.assignToChannel")}
            hint={t("createTaskDialog.fields.channelHint")}
            chips={channelChips}
            onRemove={() => setSelectedChannel("")}
            removeLabel={(chip) => t("createTaskDialog.fields.removeChannel", { name: chip.label })}
            emptyLabel={t("createTaskDialog.fields.assignToChannelEmpty")}
            addLabel={t("createTaskDialog.fields.chooseChannel")}
            doneLabel={t("createTaskDialog.fields.done")}
          >
            {channels.length === 0 ? (
              <p className="rounded-xl border border-border p-3 text-sm text-muted">
                {t("createTaskDialog.fields.noChannels")}
              </p>
            ) : (
              <div className="max-h-44 overflow-auto rounded-xl border border-border p-1">
                {channels.map((c: ChannelDTO) => {
                  const on = selectedChannel === c.id;
                  const Icon = c.isLocked ? Lock : Hash;
                  return (
                    <button
                      type="button"
                      key={c.id}
                      onClick={() => setSelectedChannel(c.id)}
                      aria-pressed={on}
                      className={`flex w-full items-center gap-2.5 rounded-lg p-2 text-left ${
                        on ? "bg-accent-soft" : "hover:bg-surface-2"
                      }`}
                    >
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-2 text-accent">
                        <Icon size={14} />
                      </span>
                      <span className="flex-1 truncate text-sm text-fg">
                        {c.name}
                        <span className="ml-1.5 text-xs text-muted">
                          {t("createTaskDialog.fields.memberCount", { count: c.memberCount })}
                        </span>
                      </span>
                      {on && <Check size={15} className="text-accent" />}
                    </button>
                  );
                })}
              </div>
            )}
          </SelectionField>
        )}

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
            <div className="mt-3 flex flex-col gap-3 rounded-xl border border-border/60 p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("createTaskDialog.allocation.startDate")}>
                  <Input type="date" value={scheduledDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setScheduledDate(e.target.value)} required />
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
                  <div className="flex flex-wrap gap-2">
                    {(["DAILY", "WEEKLY", "MONTHLY"] as const).map((kind) => (
                      <ModeTab key={kind} active={frequency === kind} onClick={() => setFrequency(kind)}>
                        {t(`createTaskDialog.allocation.${kind.toLowerCase()}`)}
                      </ModeTab>
                    ))}
                  </div>
                  <label className="flex items-center gap-2 text-sm text-fg">
                    {t(`createTaskDialog.allocation.every${frequency === "DAILY" ? "Day" : frequency === "WEEKLY" ? "Week" : "Month"}`)}
                    <Input className="w-20" type="number" min={1} value={recurrenceInterval} onChange={(e) => setRecurrenceInterval(e.target.value)} />
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
                        <Input className="w-20" type="number" min={1} max={31} value={monthlyDay} onChange={(e) => setMonthlyDay(e.target.value)} />
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
                  <div className="flex flex-wrap gap-3 text-sm">
                    {(["NO_END", "AFTER_OCCURRENCES", "ON_DATE"] as const).map((kind) => (
                      <label key={kind} className="inline-flex items-center gap-1.5 text-fg">
                        <input type="radio" name="endCondition" checked={endCondition === kind} onChange={() => setEndCondition(kind)} />
                        {t(`createTaskDialog.allocation.${kind === "NO_END" ? "noEnd" : kind === "AFTER_OCCURRENCES" ? "afterOccurrences" : "onDate"}`)}
                      </label>
                    ))}
                  </div>
                  {endCondition === "AFTER_OCCURRENCES" && <Input type="number" min={1} value={occurrenceCount} onChange={(e) => setOccurrenceCount(e.target.value)} />}
                  {endCondition === "ON_DATE" && <Input type="date" min={scheduledDate} value={endDate} onChange={(e) => setEndDate(e.target.value)} />}
                </>
              )}
            </div>
          )}
        </div>

        {/* Sticky rather than a separate prop on the shared Modal (used by ~14
            other dialogs): position:sticky pins within Modal's own scrolling
            body, so a tall form (Recurring, with every control open) never
            pushes Cancel/Create Task out of reach without touching Modal at all. */}
        <div className="sticky bottom-0 -mx-6 -mb-6 mt-2 flex justify-end gap-2 border-t border-border bg-surface px-6 py-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("createTaskDialog.actions.cancel")}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {create.isPending ? t("createTaskDialog.actions.creating") : t("createTaskDialog.actions.create")}
          </Button>
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
    <label
      className={`flex cursor-pointer flex-col gap-2 rounded-xl border p-3 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${
        checked ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-surface-2"
      }`}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} className="sr-only" />
      <span
        className={`flex h-8 w-8 items-center justify-center rounded-lg ${
          checked ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted"
        }`}
      >
        <Icon size={16} aria-hidden />
      </span>
      <span className="text-sm font-semibold text-fg">{title}</span>
      <span className="text-xs text-muted">{description}</span>
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
