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
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Check, Hash, Lock, Search, Users } from "lucide-react";
import { Avatar, Button, Input, Textarea } from "@taskboard/ui";
import { toast } from "sonner";
import type { ChannelDTO, UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { usePeopleSearch } from "../lib/usePeopleCandidates";
import { Modal } from "./Modal";
import { Field } from "../routes/Onboarding";

type Mode = "people" | "channel";

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

  // includeSelf: the People tab allows sending a task to yourself, same as
  // channel mode already allows fanning a task to a channel you're a member
  // of (see task-svc's create_task).
  const { q, setQ, candidates } = usePeopleSearch(undefined, true);
  const { data: channels = [] } = useQuery({
    queryKey: qk.channels,
    queryFn: () => api.channels(),
    enabled: open,
  });

  useEffect(() => {
    if (open) {
      setMode("people");
      setSelectedPeople(new Set(preselect.map((u) => u.id)));
      setSelectedChannel("");
      setQ("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const create = useMutation({
    mutationFn: async (): Promise<{ taskId: string; assigneeCount: number }> => {
      if (mode === "channel") {
        if (!selectedChannel) throw new Error(t("createTaskDialog.errors.pickChannel"));
        // Send the channelId — task-svc resolves the membership server-side
        // and persists tasks.channel_id so a member who joins later is
        // auto-added by the ChannelMemberJoined consumer.
        const res = await api.createTask({
          title,
          description,
          channelId: selectedChannel,
        });
        // The dialog uses the snapshot count for the success toast only —
        // server is the source of truth.
        const ch = channels.find((c) => c.id === selectedChannel);
        return { ...res, assigneeCount: ch?.memberCount ?? 0 };
      }
      const ids = [...selectedPeople];
      const res = await api.createTask({ title, description, assigneeIds: ids });
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
          : t("createTaskDialog.toasts.sentPlain"),
      );
      qc.invalidateQueries({ queryKey: qk.sent });
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
    create.mutate();
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
          <Field
            label={
              selectedPeople.size
                ? t("createTaskDialog.fields.assignToWithCount", { count: selectedPeople.size })
                : t("createTaskDialog.fields.assignTo")
            }
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
                    className={`flex w-full items-center gap-2.5 rounded-lg p-2 text-left ${
                      on ? "bg-accent-soft" : "hover:bg-surface-2"
                    }`}
                  >
                    <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
                    <span className="flex-1 truncate text-sm text-fg">{u.displayName}</span>
                    {on && <Check size={15} className="text-accent" />}
                  </button>
                );
              })}
            </div>
          </Field>
        ) : (
          <Field label={t("createTaskDialog.fields.assignToChannel")}>
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
            <p className="mt-1.5 text-[11px] text-muted">
              {t("createTaskDialog.fields.channelHint")}
            </p>
          </Field>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("createTaskDialog.actions.cancel")}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {create.isPending ? t("createTaskDialog.actions.sending") : t("createTaskDialog.actions.send")}
          </Button>
        </div>
      </form>
    </Modal>
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
