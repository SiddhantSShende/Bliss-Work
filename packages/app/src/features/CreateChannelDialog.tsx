import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Check, Search, Hash, Lock, Globe } from "lucide-react";
import { Avatar, Button, Input } from "@taskboard/ui";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { matchUser } from "../lib/matchUser";
import { Modal } from "./Modal";
import { Field } from "../routes/Onboarding";

export function CreateChannelDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const me = useSession((s) => s.user)!;
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Locked channels admit members only via explicit add (legacy invite path).
   *  Open channels accept self-join from anyone in the org. Defaults to open
   *  since most channels in a small team are discoverable. */
  const [isLocked, setIsLocked] = useState(false);

  const { data: users = [] } = useQuery({ queryKey: qk.directory, queryFn: () => api.directory() });

  useEffect(() => {
    if (open) {
      setName("");
      setQ("");
      setSelected(new Set());
      setIsLocked(false);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api.createChannel({ name: name.trim(), memberIds: [...selected], isLocked }),
    onSuccess: (ch) => {
      qc.invalidateQueries({ queryKey: qk.channels });
      qc.invalidateQueries({ queryKey: qk.openChannels });
      onClose();
      nav(`/app/channels/${ch.id}`);
    },
    onError: (e) => toast.error("Could not create channel", { description: String(e) }),
  });

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const candidates = users.filter((u) => u.id !== me.id && matchUser(u, q));

  return (
    <Modal open={open} onClose={onClose} title="New channel">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return toast.error("Name the channel");
          create.mutate();
        }}
        className="flex flex-col gap-3.5"
      >
        <Field label="Channel name">
          <div className="relative">
            <Hash size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input className="pl-9" value={name} onChange={(e) => setName(e.target.value)} placeholder="design-team" required />
          </div>
        </Field>
        <Field label="Visibility">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setIsLocked(false)}
              className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition ${
                !isLocked ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2"
              }`}
            >
              <div className="flex items-center gap-1.5 text-sm font-medium text-fg">
                <Globe size={14} /> Open
              </div>
              <div className="text-[11px] text-muted">Anyone in the org can join</div>
            </button>
            <button
              type="button"
              onClick={() => setIsLocked(true)}
              className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition ${
                isLocked ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2"
              }`}
            >
              <div className="flex items-center gap-1.5 text-sm font-medium text-fg">
                <Lock size={14} /> Locked
              </div>
              <div className="text-[11px] text-muted">Invite only</div>
            </button>
          </div>
        </Field>
        <Field label={`Members${selected.size ? ` (${selected.size})` : ""}`}>
          <div className="relative mb-2">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input className="h-10 pl-9" placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="max-h-44 overflow-auto rounded-xl border border-border p-1">
            {candidates.length === 0 && <p className="px-2 py-3 text-sm text-muted">No matches.</p>}
            {candidates.map((u) => {
              const on = selected.has(u.id);
              return (
                <button type="button" key={u.id} onClick={() => toggle(u.id)} className={`flex w-full items-center gap-2.5 rounded-lg p-2 text-left ${on ? "bg-accent-soft" : "hover:bg-surface-2"}`}>
                  <Avatar name={u.displayName} size="sm" />
                  <span className="flex-1 truncate text-sm text-fg">{u.displayName}</span>
                  {on && <Check size={15} className="text-accent" />}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={create.isPending}>{create.isPending ? "Creating…" : "Create channel"}</Button>
        </div>
      </form>
    </Modal>
  );
}
