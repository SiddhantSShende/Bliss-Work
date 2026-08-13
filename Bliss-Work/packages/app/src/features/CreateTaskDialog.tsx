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
import { Check, Hash, Lock, Search, Users } from "lucide-react";
import { Avatar, Button, Input, Textarea } from "@taskboard/ui";
import { toast } from "sonner";
import type { ChannelDTO, UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { matchUser } from "../lib/matchUser";
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
  const { api } = useRuntime();
  const qc = useQueryClient();
  const me = useSession((s) => s.user)!;
  const [mode, setMode] = useState<Mode>("people");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [q, setQ] = useState("");
  const [selectedPeople, setSelectedPeople] = useState<Set<string>>(new Set());
  const [selectedChannel, setSelectedChannel] = useState<string>("");

  const { data: users = [] } = useQuery({
    queryKey: qk.directory,
    queryFn: () => api.directory(),
  });
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
        if (!selectedChannel) throw new Error("Pick a channel");
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
          ? `Task sent to #${channel?.name ?? "channel"} — ${assigneeCount} member${assigneeCount === 1 ? "" : "s"}`
          : "Task sent",
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
    onError: (e) => toast.error("Could not create task", { description: String(e) }),
  });

  const togglePerson = (id: string) =>
    setSelectedPeople((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const candidates = users.filter((u) => matchUser(u, q));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return toast.error("Give the task a title");
    if (mode === "people" && selectedPeople.size === 0)
      return toast.error("Pick at least one assignee");
    if (mode === "channel" && !selectedChannel) return toast.error("Pick a channel");
    create.mutate();
  };

  return (
    <Modal open={open} onClose={onClose} title="New task">
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <Field label="Title">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
            placeholder="What needs doing?"
          />
        </Field>
        <Field label="Description">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add details…"
          />
        </Field>

        <div className="flex gap-1">
          <ModeTab active={mode === "people"} onClick={() => setMode("people")}>
            <Users size={13} /> People
          </ModeTab>
          <ModeTab active={mode === "channel"} onClick={() => setMode("channel")}>
            <Hash size={13} /> Channel
          </ModeTab>
        </div>

        {mode === "people" ? (
          <Field
            label={`Assign to${selectedPeople.size ? ` (${selectedPeople.size})` : ""}`}
          >
            <div className="relative mb-2">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
              />
              <Input
                className="h-10 pl-9"
                placeholder="Search people…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <div className="max-h-44 overflow-auto rounded-xl border border-border p-1">
              {candidates.length === 0 && (
                <p className="px-2 py-3 text-sm text-muted">No matches.</p>
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
                    <Avatar name={u.displayName} size="sm" />
                    <span className="flex-1 truncate text-sm text-fg">
                      {u.displayName}
                      {u.id === me.id && <span className="text-muted"> (you)</span>}
                    </span>
                    {on && <Check size={15} className="text-accent" />}
                  </button>
                );
              })}
            </div>
          </Field>
        ) : (
          <Field label="Assign to channel">
            {channels.length === 0 ? (
              <p className="rounded-xl border border-border p-3 text-sm text-muted">
                You aren't in any channels yet. Create one from the Channels sidebar.
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
                          ({c.memberCount} member{c.memberCount === 1 ? "" : "s"})
                        </span>
                      </span>
                      {on && <Check size={15} className="text-accent" />}
                    </button>
                  );
                })}
              </div>
            )}
            <p className="mt-1.5 text-[11px] text-muted">
              Every member of the channel receives the task with the same Acknowledge / Ignore flow.
            </p>
          </Field>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            {create.isPending ? "Sending…" : "Send task"}
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
