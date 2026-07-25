import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Users, Forward, Send } from "lucide-react";
import { toast } from "sonner";
import { Avatar, Input, EmptyState, Button } from "@taskboard/ui";
import type { UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { matchUser, rankUsers } from "../lib/matchUser";
import { Modal } from "./Modal";

/**
 * Forward a message — either to another Bliss-Work user (in-app relay) or OUT to a
 * contact on a connected external platform (Slack channel, WhatsApp number, …).
 * Either way the ORIGINAL author is notified and the forward is recorded in the
 * forwarding-activity tree, with the platform tagged. Enterprise-plan only
 * (server-enforced); the caller only renders this when the plan allows.
 */
export function ForwardDialog({
  open,
  onClose,
  sourceMessageId,
  preview,
}: {
  open: boolean;
  onClose: () => void;
  sourceMessageId: string | null;
  preview?: string;
}) {
  const [mode, setMode] = useState<"internal" | "external">("internal");
  useEffect(() => {
    if (open) setMode("internal");
  }, [open]);

  return (
    <Modal open={!!sourceMessageId && open} onClose={onClose} title="Forward message">
      {preview && (
        <div className="mb-3 flex items-start gap-2 rounded-xl bg-surface-2 p-2.5 text-xs text-muted">
          <Forward size={14} className="mt-0.5 shrink-0 text-accent" />
          <span className="line-clamp-2 break-words">{preview}</span>
        </div>
      )}
      <div className="mb-3 flex gap-1 rounded-xl bg-surface-2 p-1 text-xs font-medium">
        <button
          onClick={() => setMode("internal")}
          className={`flex-1 rounded-lg py-1.5 transition-colors ${mode === "internal" ? "bg-surface text-fg shadow-sm" : "text-muted"}`}
        >
          Bliss-Work
        </button>
        <button
          onClick={() => setMode("external")}
          className={`flex-1 rounded-lg py-1.5 transition-colors ${mode === "external" ? "bg-surface text-fg shadow-sm" : "text-muted"}`}
        >
          External
        </button>
      </div>
      {mode === "internal" ? (
        <InternalForward sourceMessageId={sourceMessageId} onDone={onClose} />
      ) : (
        <ExternalForward sourceMessageId={sourceMessageId} onDone={onClose} />
      )}
    </Modal>
  );
}

function InternalForward({ sourceMessageId, onDone }: { sourceMessageId: string | null; onDone: () => void }) {
  const { api } = useRuntime();
  const me = useSession((s) => s.user)!;
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data: users = [] } = useQuery({ queryKey: qk.directory, queryFn: () => api.directory() });
  const results = rankUsers(users.filter((u) => u.id !== me.id && matchUser(u, q)), q);

  const forwardTo = async (u: UserDTO) => {
    if (!sourceMessageId) return;
    setBusyId(u.id);
    try {
      await api.forwardMessage(sourceMessageId, u.id);
      toast.success(`Forwarded to ${u.displayName}`);
      onDone();
    } catch {
      toast.error("Couldn't forward message", { description: "Please try again." });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="relative mb-3">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <Input className="pl-9" placeholder="Forward to…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <div className="max-h-72 overflow-auto">
        {results.length === 0 ? (
          <EmptyState icon={<Users size={20} />} title="No people found" />
        ) : (
          <div className="space-y-0.5">
            {results.map((u) => (
              <button
                key={u.id}
                disabled={busyId !== null}
                onClick={() => forwardTo(u)}
                className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors hover:bg-surface-2 disabled:opacity-50"
              >
                <Avatar name={u.displayName} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-fg">{u.displayName}</div>
                  <div className="truncate text-xs text-muted">@{u.username}</div>
                </div>
                {busyId === u.id && <span className="text-xs text-muted">Forwarding…</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function ExternalForward({ sourceMessageId, onDone }: { sourceMessageId: string | null; onDone: () => void }) {
  const { api } = useRuntime();
  const [connId, setConnId] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: conns = [], isLoading } = useQuery({ queryKey: qk.integrations, queryFn: () => api.integrations() });
  const connected = conns.filter((c) => c.status === "connected");
  useEffect(() => {
    const first = connected[0];
    if (!connId && first) setConnId(first.id);
  }, [connected, connId]);

  const send = async () => {
    if (!sourceMessageId || !connId || !target.trim()) return;
    setBusy(true);
    try {
      const res = await api.forwardMessageExternal(sourceMessageId, connId, target.trim());
      toast.success(`Forwarded via ${res.platform}`);
      onDone();
    } catch {
      toast.error("Couldn't forward to the external contact", { description: "Check the connection and target." });
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <div className="p-4 text-sm text-muted">Loading connected accounts…</div>;
  if (connected.length === 0)
    return (
      <EmptyState
        icon={<Forward size={20} />}
        title="No connected accounts"
        hint="Connect an account in the Integrations section first."
      />
    );

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">Account</span>
        <select
          value={connId}
          onChange={(e) => setConnId(e.target.value)}
          className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg focus-visible:border-accent focus-visible:outline-none"
        >
          {connected.map((c) => (
            <option key={c.id} value={c.id}>
              {c.provider} — {c.displayLabel || c.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">To</span>
        <Input
          placeholder="Phone number or channel ID"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
      </label>
      <div className="flex justify-end">
        <Button size="sm" disabled={!connId || !target.trim() || busy} onClick={send}>
          <Send size={14} /> {busy ? "Sending…" : "Forward"}
        </Button>
      </div>
    </div>
  );
}
