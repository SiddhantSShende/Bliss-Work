/**
 * "New task" modal.
 *
 * Left: what the task is and when it is allocated (title, description, Now /
 * Schedule / Recurring, deadline). Right: who gets it — the AssignToPanel, a People
 * tab and a Channels tab, each a searchable, lazily loaded list; either, or both,
 * may be filled. One Create is one request and one task: task-svc takes
 * `assigneeIds` and `channelIds` together, resolves each channel's members, and
 * keeps the channels attached to the task so a later joiner is added too.
 *
 * Selection is held HERE, as ids, not in the lists: the lists load a page at a time
 * and a picked person or channel is routinely not in the page on screen.
 *
 * Locked channels appear here only if the caller is a member; open channels they
 * aren't in are intentionally excluded — the assigner has to join first.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CalendarClock, Repeat, Zap, type LucideIcon } from "lucide-react";
import { Button, Input, Textarea } from "@taskboard/ui";
import { toast } from "sonner";
import type { ChannelDTO, ProjectDTO, UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { dayLabel, timeLabel } from "../lib/meetingTime";
import { localDateTimeWithOffset } from "../lib/taskDates";
import { localDay } from "../lib/dateRange";
import { deadlineProblem, deadlineRequest, emptyDeadline, type Allocation, type DeadlineForm, type DeadlineProblem } from "../lib/taskDeadline";
import { Modal } from "./Modal";
import { Field } from "../routes/Onboarding";
import { AssignToPanel, type ChannelPickLike } from "./AssignToPanel";
import { TaskDeadlineField } from "./TaskDeadlineField";
import { TimePicker } from "./TimePicker";
import { useChannelMemberIds } from "./useChannelMemberIds";
import { ProjectCreationDialog } from "./ProjectCreationDialog";


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

/** A picked channel: just what the summary line and the success toast say about it. */
type ChannelPick = { name: string; memberCount: number };

/** Smart Task Allocation (Section 8 of the allocation spec): the server is the
 *  only authority on the final title — this mirrors Rules A/C/D/F for the
 *  PREVIEW only, using names already known client-side. Rules B/E/G/H (more
 *  than one channel, more than one person, a channel+person mix, or more
 *  than one project) all collapse to "a project name is required", which the
 *  preview shows literally rather than guessing a name. */
function previewTitle({
  projects,
  channels,
  peopleNames,
  newProjectName,
}: {
  projects: Map<string, ProjectDTO>;
  channels: Map<string, ChannelPick>;
  peopleNames: Map<string, string>;
  newProjectName: string;
}): { title: string; needsNewProjectName: boolean } {
  const firstProject = projects.values().next().value;
  if (projects.size === 1 && firstProject) return { title: firstProject.name, needsNewProjectName: false };
  const needsNewProjectName =
    projects.size > 1 || channels.size > 1 || peopleNames.size > 1 || (channels.size >= 1 && peopleNames.size >= 1);
  if (needsNewProjectName) return { title: newProjectName.trim(), needsNewProjectName: true };
  const firstChannel = channels.values().next().value;
  if (channels.size === 1 && firstChannel) return { title: firstChannel.name, needsNewProjectName: false };
  const firstPersonName = peopleNames.values().next().value;
  if (peopleNames.size === 1 && firstPersonName) return { title: firstPersonName, needsNewProjectName: false };
  return { title: "", needsNewProjectName: false };
}

export function CreateTaskDialog({
  open,
  onClose,
  preselect = [],
  prefillTaskTitle,
  prefillDescription,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  preselect?: UserDTO[];
  /** Seeds the task title field when the dialog opens — "Create task" from a
   *  self-chat note. Omitted (every existing call site), the field opens
   *  blank exactly as it always has. Only applied on open, same as
   *  `preselect` below: editing it after is a prop update, not a reset. */
  prefillTaskTitle?: string;
  /** Seeds the description field alongside `prefillTaskTitle` above. */
  prefillDescription?: string;
  /** Fires once, after the task is actually created, with its id — so a
   *  caller that opened this dialog FOR something (a message, a note) can
   *  link back to the real task it created. Omitted, nothing extra happens;
   *  the dialog's own success toast + close still do. */
  onCreated?: (taskId: string) => void;
}) {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [description, setDescription] = useState("");
  const [selectedPeople, setSelectedPeople] = useState<Set<string>>(new Set());
  // Display names for the title preview only — ids above are what's actually sent.
  const [peopleNames, setPeopleNames] = useState<Map<string, string>>(new Map());
  // Keyed by channel id; the value is only what this form later SAYS about the channel,
  // captured when it was picked — the dialog never holds the channel list itself.
  const [selectedChannels, setSelectedChannels] = useState<Map<string, ChannelPick>>(new Map());
  // Keyed by project id, full DTO so the preview/summary can show its name and
  // (Section 7.3) its channels can be folded into the submission as real
  // recipients — see the `effectiveChannelIds` memo below.
  const [selectedProjects, setSelectedProjects] = useState<Map<string, ProjectDTO>>(new Map());
  // Section 7.4: a project-derived channel the user explicitly unchecked.
  // Removing it this way never touches the project itself — reselecting the
  // SAME project re-includes its channels (see toggleProject), but this set
  // is what lets one channel be opted out while the project stays picked.
  const [excludedChannelIds, setExcludedChannelIds] = useState<Set<string>>(new Set());
  const [newProjectName, setNewProjectName] = useState("");
  // "+ New" beside the dialog's heading (Section 6.4) opens the real
  // standalone project-creation dialog (POST /api/v1/projects) — the created
  // project is then selected here exactly like one picked from the Projects
  // tab (see its onCreated below).
  const [creatingProject, setCreatingProject] = useState(false);
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

  // Every channel the caller can see, used only to resolve a NAME for a
  // project-derived channel row (Section 7.3/7.4) — the project itself only
  // carries channel ids. A channel the caller is not a member of (so not in
  // this list) still works as an allocation target; it just can't show a
  // name here, same "has to join first" limit already on the picker below.
  //
  // Every channel id pulled in by a currently selected project, regardless
  // of whether the user has excluded it (see excludedChannelIds above) —
  // this is what renders the project-derived ROWS, so an excluded one still
  // shows up, just unchecked and re-selectable.
  const projectDerivedChannelIds = useMemo(() => {
    const ids = new Set<string>();
    for (const project of selectedProjects.values()) for (const id of project.channelIds) ids.add(id);
    return ids;
  }, [selectedProjects]);
  // Fetched ONLY once a project is actually selected: this is the caller's
  // WHOLE channel list, which the ordinary Channels-tab picker deliberately
  // never fetches (it stays page-at-a-time, however large the org) — the
  // one-time cost here is the price of resolving a project-derived
  // channel's NAME, and only paid when there is one to resolve.
  const allChannels = useQuery({
    queryKey: qk.channels,
    queryFn: () => api.channels(),
    enabled: projectDerivedChannelIds.size > 0,
    staleTime: 30_000,
  });
  const channelNameById = useMemo(() => {
    const byId = new Map<string, ChannelDTO>();
    for (const c of allChannels.data ?? []) byId.set(c.id, c);
    return byId;
  }, [allChannels.data]);
  const projectDerivedChannels = useMemo(
    () =>
      [...projectDerivedChannelIds].map((id) => {
        const known = channelNameById.get(id);
        return { id, name: known?.name ?? "", memberCount: known?.memberCount ?? 0 };
      }),
    [projectDerivedChannelIds, channelNameById],
  );

  // What actually gets allocated to: direct picks plus project-derived
  // channels, minus anything explicitly excluded (Section 7.3/7.4).
  const effectiveChannelEntries = useMemo(() => {
    const entries = new Map<string, ChannelPick>(selectedChannels);
    for (const c of projectDerivedChannels) if (!entries.has(c.id)) entries.set(c.id, { name: c.name, memberCount: c.memberCount });
    for (const id of excludedChannelIds) entries.delete(id);
    return entries;
  }, [selectedChannels, projectDerivedChannels, excludedChannelIds]);
  const effectiveChannelIds = useMemo(() => [...effectiveChannelEntries.keys()], [effectiveChannelEntries]);

  // Smart Task Allocation (Section 8): derive the title preview from the
  // current selection. The server is the only authority on the FINAL title
  // (app/allocation.py) — this is a preview only. Uses the EFFECTIVE channel
  // set (not just direct picks) so the preview matches what create() sends.
  const { title: previewedTitle, needsNewProjectName: ruleNeedsNewProjectName } = useMemo(
    () => previewTitle({ projects: selectedProjects, channels: effectiveChannelEntries, peopleNames, newProjectName }),
    [selectedProjects, effectiveChannelEntries, peopleNames, newProjectName],
  );
  const needsNewProjectName = ruleNeedsNewProjectName;
  const titlePreview = selectedProjects.size === 1 ? previewedTitle : needsNewProjectName ? newProjectName.trim() : previewedTitle;

  // Membership auto-add (Section 7.2/7.5): a person picked in the People tab
  // who is not already a member of a channel picked DIRECTLY in the Channels
  // tab gets added to that channel through the app's existing membership
  // workflow (api.addChannelMembers — the same one-call-per-channel, atomic,
  // manager/org_admin-gated endpoint ChannelMembersSheet already uses).
  //
  // Scope is deliberately narrow and explicit, per the spec's "only add
  // people to channels that are part of the current operation" and "prefer
  // requiring explicit channel selection when ambiguous":
  //   - only channels picked directly here (never a project's channels —
  //     being pulled in as a task recipient via a project is not the same
  //     as the user asking to add someone to that channel);
  //   - a person missing from several selected channels is added to EVERY
  //     one of them (each a channel the user explicitly picked, so this is
  //     never ambiguous, just "more than one explicit target").
  // Server-side authorization (owner/admin/org_admin) is the real gate —
  // this is only about computing WHO is missing from WHERE.
  const channelMembership = useChannelMemberIds(selectedChannels.keys());

  // Allocation sync fix (bug: picking a channel/project never reflected its
  // members in the People tab). Resolves member ids for every EFFECTIVELY
  // selected channel (direct picks and project-derived ones alike) so the
  // People tab can show them as already-included, deduped across channels.
  // Deliberately a SEPARATE useChannelMemberIds call from `channelMembership`
  // above, which is scoped to only DIRECTLY-picked channels for the
  // "add a missing person to that channel" feature — these answer two
  // different questions (who already gets the task vs. who should be added
  // to a channel) and must not be conflated. React Query dedupes the
  // overlapping channel ids between the two calls itself. This never adds or
  // removes real channel membership — see AssignToPanel's `channelMemberIds`
  // doc comment for how it's rendered.
  const effectiveChannelMembership = useChannelMemberIds(effectiveChannelIds);
  const channelMemberPeopleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const channelId of effectiveChannelIds) {
      const members = effectiveChannelMembership.members.get(channelId);
      if (members) for (const id of members) ids.add(id);
    }
    return ids;
  }, [effectiveChannelIds, effectiveChannelMembership.members]);

  const missingChannelMembers = useMemo(() => {
    const entries: [string, string[]][] = [];
    for (const channelId of selectedChannels.keys()) {
      const current = channelMembership.members.get(channelId);
      if (!current) continue; // still loading, or failed to load — see submit()
      const missing = [...selectedPeople].filter((id) => !current.includes(id));
      if (missing.length > 0) entries.push([channelId, missing]);
    }
    return entries;
  }, [selectedChannels, selectedPeople, channelMembership.members]);
  // True only once every selected channel's membership has actually loaded
  // (or failed) — while any is still in flight, missingChannelMembers can
  // understate who needs adding, so submit() waits rather than guessing.
  const channelMembershipSettled = [...selectedChannels.keys()].every((id) => channelMembership.members.has(id));

  // "Schedule for later"'s small allocation summary — who, and the real
  // combined start moment (same localDateTimeWithOffset the request itself
  // is built from, so the summary can never say something the request doesn't).
  const summaryTargets = [
    ...(selectedProjects.size > 0 ? [...selectedProjects.values()].map((p) => p.name) : []),
    ...(selectedPeople.size > 0 ? [t("createTaskDialog.allocation.peopleCount", { count: selectedPeople.size })] : []),
    ...[...effectiveChannelEntries.values()].map((c) => `#${c.name}`),
  ];
  const summaryWho = summaryTargets.length > 0 ? summaryTargets.join(", ") : t("createTaskDialog.allocation.noTargetYet");
  const summaryStartIso = localDateTimeWithOffset(scheduledDate, scheduledTime);
  const summaryWhen = summaryStartIso
    ? `${dayLabel(new Date(summaryStartIso).getTime())} · ${timeLabel(new Date(summaryStartIso).getTime())}`
    : null;

  const formId = useId();

  useEffect(() => {
    if (open) {
      // Only touched when a caller actually asks for a prefill — every
      // existing call site that doesn't pass one keeps today's behavior
      // (whatever was left in these fields from before, cleared only on a
      // successful create below). There is no task-title field any more
      // (Smart Task Allocation derives it server-side), so a caller that
      // used to seed just the title now seeds the description instead —
      // the message text a "Create task" action started from is still
      // there to read, never silently dropped.
      if (prefillDescription !== undefined) setDescription(prefillDescription);
      else if (prefillTaskTitle !== undefined) setDescription(prefillTaskTitle);
      const initialPeople = new Map(preselect.map((u) => [u.id, u.displayName || u.username]));
      setSelectedPeople(new Set(initialPeople.keys()));
      setPeopleNames(initialPeople);
      setSelectedChannels(new Map());
      setSelectedProjects(new Map());
      setExcludedChannelIds(new Set());
      setNewProjectName("");
      setCreatingProject(false);
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

  // isPending only flips after React re-renders, so a second submit in the same
  // tick (Enter held, double click) would otherwise send a second request — and
  // a second task, since each request mints its own idempotency key.
  const inFlight = useRef(false);

  // Exactly one project selected: use it as-is (Rule F). More than one, or none
  // but the selection needs one (Rule B/E/G/H): a new project, named by the
  // user — the server creates it. Neither: no project at all (Rule A/C/D).
  const singleProjectId = selectedProjects.size === 1 ? [...selectedProjects.keys()][0] : undefined;

  // Membership auto-add runs BEFORE task creation, as its own request per
  // channel (api.addChannelMembers is already atomic server-side — see its
  // doc comment). If any channel's add fails (most likely: the caller isn't
  // that channel's owner/admin/org_admin), submit() stops here and does NOT
  // create the task — the spec's "do not pretend to succeed" rule for a
  // partial failure. The selection is left exactly as the user built it, so
  // fixing the one problem channel (e.g. deselecting it) and retrying works.
  const addMembers = useMutation({
    mutationFn: (entries: [string, string[]][]) =>
      Promise.all(entries.map(([channelId, ids]) => api.addChannelMembers(channelId, ids))),
  });

  const create = useMutation({
    // ONE request for the whole selection, whatever mix of projects, people and
    // channels it is. task-svc resolves each channel's members (so someone both
    // picked and in a picked channel is still one recipient) and keeps the
    // channels attached to the task, so a member who joins one later is added.
    mutationFn: () =>
      api.createTask({
        description,
        allocation,
        ...(singleProjectId
          ? { projectId: singleProjectId }
          : needsNewProjectName
            ? { newProjectName: newProjectName.trim() }
            : {}),
        ...(selectedPeople.size > 0 ? { assigneeIds: [...selectedPeople] } : {}),
        ...(effectiveChannelIds.length > 0 ? { channelIds: effectiveChannelIds } : {}),
        ...(allocation === "SCHEDULED" ? { scheduledFor: localDateTimeWithOffset(scheduledDate, scheduledTime)! } : {}),
        ...(allocation === "RECURRING" ? { recurrence: recurrencePayload() } : {}),
        ...(deadlineAt ? { deadlineAt } : {}),
      }),
    onSuccess: (data) => {
      onCreated?.(data.taskId);
      // Only a lone channel gets the channel-specific toast: with people (or other
      // channels) alongside it, "sent to #general — 12 members" would undercount.
      const assignmentChannels = [...selectedChannels.values()];
      const lone = selectedPeople.size === 0 && assignmentChannels.length === 1 ? assignmentChannels[0] : undefined;
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
      qc.invalidateQueries({ queryKey: qk.projects });
      // Self-assignment also makes the new task appear in Allocated to me.
      // Keep this mutation-owned cache fresh even if the deduplicated task
      // event arrives before the active view has subscribed to it.
      qc.invalidateQueries({ queryKey: qk.assigned });
      qc.invalidateQueries({ queryKey: qk.unifiedInbox });
      // New SENT rows change the "n pending, unacked" hints in the Available
      // bucket (allocating doesn't make anyone unavailable, but it does queue).
      qc.invalidateQueries({ queryKey: qk.availability });
      setDescription("");
      setSelectedPeople(new Set());
      setPeopleNames(new Map());
      setSelectedChannels(new Map());
      setSelectedProjects(new Map());
      setExcludedChannelIds(new Set());
      setNewProjectName("");
      setCreatingProject(false);
      onClose();
    },
    onError: (e) => toast.error(t("createTaskDialog.errors.createFailed"), { description: String(e) }),
    onSettled: () => {
      inFlight.current = false;
    },
  });

  const togglePerson = (user: UserDTO) => {
    setSelectedPeople((s) => toggled(s, user.id));
    setPeopleNames((current) => {
      const next = new Map(current);
      if (next.has(user.id)) next.delete(user.id);
      else next.set(user.id, user.displayName || user.username);
      return next;
    });
  };
  // One toggle handles a channel regardless of where its row came from
  // (picked directly, or shown because a selected project includes it):
  // unchecking always excludes it from the effective set AND drops any
  // direct pick, checking always un-excludes it AND ensures a direct pick
  // exists — so it stays selected even if its project is later deselected.
  const toggleChannel = (channel: ChannelPickLike) => {
    const wasEffectivelySelected = effectiveChannelEntries.has(channel.id);
    setExcludedChannelIds((excluded) => {
      const next = new Set(excluded);
      if (wasEffectivelySelected) next.add(channel.id);
      else next.delete(channel.id);
      return next;
    });
    setSelectedChannels((s) => {
      const next = new Map(s);
      if (wasEffectivelySelected) next.delete(channel.id);
      else next.set(channel.id, { name: channel.name, memberCount: channel.memberCount });
      return next;
    });
  };
  const toggleProject = (project: ProjectDTO) => {
    setSelectedProjects((s) => {
      const next = new Map(s);
      if (!next.delete(project.id)) next.set(project.id, project);
      return next;
    });
    // Re-selecting (or deselecting) a project resets any exclusion on ITS
    // channels — picking a project is opting back into its default scope.
    setExcludedChannelIds((excluded) => {
      if (excluded.size === 0) return excluded;
      const next = new Set(excluded);
      for (const id of project.channelIds) next.delete(id);
      return next;
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    // A selected channel's member list is still loading: wait rather than
    // guess, since missingChannelMembers would understate who needs adding
    // and silently skip them (see its own comment above).
    if (!channelMembershipSettled) return toast.error(t("createTaskDialog.errors.stillCheckingMembership"));
    if (selectedProjects.size === 0 && selectedChannels.size === 0 && selectedPeople.size === 0)
      return toast.error(t("createTaskDialog.errors.needSelection"));
    if (needsNewProjectName && !newProjectName.trim())
      return toast.error(t("createTaskDialog.errors.needProjectName"));
    if (!singleProjectId && !needsNewProjectName && effectiveChannelIds.length === 0 && selectedPeople.size === 0)
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
    inFlight.current = true;
    if (missingChannelMembers.length > 0) {
      try {
        await addMembers.mutateAsync(missingChannelMembers);
      } catch (err) {
        inFlight.current = false;
        return toast.error(t("createTaskDialog.errors.membershipAddFailed"), { description: String(err) });
      }
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
      ...(recurrenceDeadline ? { deadline: recurrenceDeadline } : {}),
    } as const;
  };

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title={t("createTaskDialog.title")}
      wide
      showClose
      headerExtra={
        <Button type="button" variant="ghost" onClick={() => setCreatingProject(true)}>
          {t("createTaskDialog.assign.newProject")}
        </Button>
      }
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
      <form id={formId} onSubmit={submit} className="grid gap-x-6 gap-y-3.5 md:grid-cols-2">
        {/* LEFT: what the task is and when it is allocated — the selected allocation
            mode decides which of start / repeat / deadline appear. */}
        <div className="flex min-w-0 flex-col gap-3.5">
          {/* Smart Task Allocation: no manual title. A read-only preview shows what
              the server will derive (Rules A/C/D/F); a project name is asked for
              only when the selection actually needs one (Rules B/E/G/H). */}
          <Field label={t("createTaskDialog.fields.titlePreview")}>
            <Input
              value={titlePreview}
              readOnly
              placeholder={t("createTaskDialog.fields.titlePreviewPlaceholder")}
              className="cursor-default bg-surface-2 text-muted"
            />
          </Field>
          {needsNewProjectName && (
            <Field label={t("createTaskDialog.fields.newProjectName")}>
              <Input
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                required
                maxLength={200}
                placeholder={t("createTaskDialog.fields.newProjectNamePlaceholder")}
              />
            </Field>
          )}
          <Field label={t("createTaskDialog.fields.description")}>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="min-h-[4.5rem]"
              placeholder={t("createTaskDialog.fields.descriptionPlaceholder")}
            />
          </Field>

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
                    <Input type="date" value={scheduledDate} min={localDay(new Date())} onChange={(e) => setScheduledDate(e.target.value)} required className="h-9" />
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
                          <button key={label} type="button" onClick={() => setWeekdays((current) => toggled(current, day))} className={`rounded-full px-2.5 py-1 text-xs ${weekdays.has(day) ? "bg-gradient-to-br from-brand-from via-brand-mid to-brand-to text-accent-fg" : "bg-surface-2 text-muted"}`}>
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                    {frequency === "MONTHLY" && (
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <select className="rounded-lg border border-border bg-surface px-2 py-1.5" value={monthlyRule} onChange={(e) => setMonthlyRule(e.target.value as typeof monthlyRule)}>
                          <option value="DAY_OF_MONTH">{t("createTaskDialog.allocation.dayOfMonth")}</option>
                          <option value="WEEKDAY_PATTERN">{t("createTaskDialog.allocation.weekdayPattern")}</option>
                        </select>
                        {monthlyRule === "DAY_OF_MONTH" ? (
                          <Input className="h-9 w-20" type="number" min={1} max={31} value={monthlyDay} onChange={(e) => setMonthlyDay(e.target.value)} />
                        ) : (
                          <>
                            <select className="rounded-lg border border-border bg-surface px-2 py-1.5" value={monthlyOrdinal} onChange={(e) => setMonthlyOrdinal(e.target.value)}>
                              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{t(`createTaskDialog.allocation.ordinal.${n}`)}</option>)}
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

        {/* RIGHT: who gets it. The panel's list fills this column and scrolls inside
            it, so the dialog is as tall as the left column asks, never as long as
            the organisation. */}
        <div className="flex min-w-0 flex-col md:border-l md:border-border/60 md:pl-6">
          <AssignToPanel
            people={selectedPeople}
            channels={new Set(effectiveChannelIds)}
            projects={new Set(selectedProjects.keys())}
            projectDerivedChannels={projectDerivedChannels}
            channelMemberIds={channelMemberPeopleIds}
            initialTab="channels"
            onTogglePerson={togglePerson}
            onToggleChannel={toggleChannel}
            onToggleProject={toggleProject}
          />
        </div>
      </form>
    </Modal>
    <ProjectCreationDialog
      open={creatingProject}
      onClose={() => setCreatingProject(false)}
      onCreated={(project) => {
        setSelectedProjects((s) => new Map(s).set(project.id, project));
        setCreatingProject(false);
      }}
    />
    </>
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
        checked
          ? "border-accent bg-gradient-to-br from-brand-from/15 to-brand-to/15"
          : "border-border bg-surface hover:bg-surface-2"
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
            checked
              ? "bg-gradient-to-br from-brand-from via-brand-mid to-brand-to text-accent-fg"
              : "bg-surface-2 text-muted"
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
        active
          ? "bg-gradient-to-br from-brand-from via-brand-mid to-brand-to text-accent-fg"
          : "bg-surface-2 text-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}
