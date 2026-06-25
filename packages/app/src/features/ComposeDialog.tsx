import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Check, Search, MessageSquare, ListTodo, X } from "lucide-react";
import { Avatar, Button, Input, Textarea } from "@taskboard/ui";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { matchUser } from "../lib/matchUser";
import { Modal } from "./Modal";
import { Field } from "../routes/Onboarding";

type Mode = "message" | "task";

/**
 * Unified Inbox composer: send a 1:1 message OR assign a task to one or more
 * teammates, from a single dialog.
 *
 *   Message → strictly 1:1 (the messaging model is per ordered-pair); on send we
 *             drop the user into the new thread so they can keep typing.
 *   Task    → fans out to every selected assignee (task-svc emits one
 *             task.assigned per assignee).
 *
 * Built on the same primitives as CreateTaskDialog (Modal + Field + the
 * directory picker) for visual + behavioural consistency.
 */
export function ComposeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const nav = useNavigate();
  const me = useSession((s) => s.user)!;

  const [mode, setMode] = useState<Mode>("message");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [body, setBody] = useState(""); // message
  const [title, setTitle] = useState(""); // task
  const [description, setDescription] = useState(""); // task

  const { data: users = [] } = useQuery({ queryKey: qk.directory, queryFn: () => api.directory() });

  // Reset every field each time the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setMode("message");
      setSelected(new Set());
      setQ("");
      setBody("");
      setTitle("");
      setDescription("");
    }
  }, [open]);

  // Message mode is 1:1 — collapse any multi-selection when switching to it.
  const switchMode = (next: Mode) => {
    setMode(next);
    if (next === "message")
      setSelected((s) => {
        if (s.size <= 1) return s;
        const [first] = [...s];
        return first ? new Set([first]) : new Set();
      });
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      if (mode === "message") return s.has(id) ? new Set() : new Set([id]);
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const send = useMutation({
    mutationFn: async () => {
      const ids = [...selected];
      if (mode === "message") {
        const res = await api.sendMessage(ids[0]!, body.trim());
        return { kind: "message" as const, threadId: res.threadId };
      }
      await api.createTask({ title: title.trim(), description: description.trim(), assigneeIds: ids });
      return { kind: "task" as const };
    },
    onSuccess: (out) => {
      if (out.kind === "message") {
        toast.success("Message sent");
        void qc.invalidateQueries({ queryKey: qk.inboxPeers });
        void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
        void qc.invalidateQueries({ queryKey: qk.conversations });
        onClose();
        nav(`/app/inbox/thread/${out.threadId}`);
      } else {
        toast.success(selected.size > 1 ? `Task sent to ${selected.size} people` : "Task sent");
        void qc.invalidateQueries({ queryKey: qk.sent });
        onClose();
      }
    },
    onError: (e) => toast.error("Could not send", { description: String(e) }),
  });

  const canSend =
    mode === "message"
      ? selected.size === 1 && body.trim().length > 0
      : selected.size >= 1 && title.trim().length > 0;

  const candidates = users.filter((u) => matchUser(u, q));
  const selectedUsers = users.filter((u) => selected.has(u.id));

  return (
    <Modal open={open} onClose={onClose} title="Compose">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) send.mutate();
        }}
        className="flex flex-col gap-3.5"
      >
        {/* Message / Task toggle */}
        <div className="flex gap-1 rounded-xl border border-border p-1 text-sm">
          <ToggleBtn active={mode === "message"} onClick={() => switchMode("message")}>
            <MessageSquare size={15} /> Message
          </ToggleBtn>
          <ToggleBtn active={mode === "task"} onClick={() => switchMode("task")}>
            <ListTodo size={15} /> Task
          </ToggleBtn>
        </div>

        {/* Recipient picker — single in Message mode, multi in Task mode */}
        <Field label={mode === "message" ? "To" : `Assign to${selected.size ? ` (${selected.size})` : ""}`}>
          {selectedUsers.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {selectedUsers.map((u) => (
                <span
                  key={u.id}
                  className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-1 text-xs text-accent"
                >
                  {u.displayName}
                  <button type="button" onClick={() => toggle(u.id)} title="Remove" className="hover:text-danger">
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="relative mb-2">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input className="h-10 pl-9" placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="max-h-40 overflow-auto rounded-xl border border-border p-1">
            {candidates.length === 0 && <p className="px-2 py-3 text-sm text-muted">No matches.</p>}
            {candidates.map((u) => {
              const on = selected.has(u.id);
              return (
                <button
                  type="button"
                  key={u.id}
                  onClick={() => toggle(u.id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg p-2 text-left ${on ? "bg-accent-soft" : "hover:bg-surface-2"}`}
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

        {/* Body — message text, or task title + description */}
        {mode === "message" ? (
          <Field label="Message">
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} required placeholder="Write a message…" />
          </Field>
        ) : (
          <>
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
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Add details…" />
            </Field>
          </>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={send.isPending} disabled={!canSend}>
            {send.isPending ? "Sending…" : mode === "message" ? "Send message" : "Send task"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ToggleBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 font-medium transition-colors ${
        active ? "bg-gradient-to-br from-brand-from to-brand-to text-accent-fg shadow-soft" : "text-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}
