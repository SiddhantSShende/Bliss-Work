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
import { WhatsAppForward } from "./WhatsAppForward";

/**
 * Forward a message: to another Bliss-Work user (in-app relay), OUT through a
 * connected external account, or by handing it to WhatsApp as a deep link.
 * Whichever route, the ORIGINAL author is notified and the forward is recorded
 * in the forwarding-activity tree with the platform tagged.
 *
 * Available to EVERY org member. The plan gate this used to describe was removed
 * in 465a195: each org now supplies its own provider credentials, so there is
 * nothing central to meter.
 *
 * `scope` is not cosmetic. The in-app relay and the connected-account send both
 * resolve their source through `messages JOIN conversations` server-side, so a
 * channel message 403s on both — only the deep link accepts one. Offering tabs
 * that cannot work is worse than not offering them, so a channel source shows
 * the WhatsApp route alone.
 */
export function ForwardDialog({
  open,
  onClose,
  sourceMessageId,
  preview,
  scope = "dm",
}: {
  open: boolean;
  onClose: () => void;
  sourceMessageId: string | null;
  /** The FULL body of the source message — clamped to two lines for display,
   *  and used verbatim as the text prefilled into WhatsApp. */
  preview?: string;
  scope?: "dm" | "channel";
}) {
  const channelSource = scope === "channel";
  const [mode, setMode] = useState<"internal" | "external" | "walink">("internal");
  useEffect(() => {
    if (open) setMode(channelSource ? "walink" : "internal");
  }, [open, channelSource]);

  return (
    <Modal open={!!sourceMessageId && open} onClose={onClose} title="Forward message">
      {preview && (
        <div className="mb-3 flex items-start gap-2 rounded-xl bg-surface-2 p-2.5 text-xs text-muted">
          <Forward size={14} className="mt-0.5 shrink-0 text-accent" />
          <span className="line-clamp-2 break-words">{preview}</span>
        </div>
      )}
      {!channelSource && (
        <div className="mb-3 flex gap-1 rounded-xl bg-surface-2 p-1 text-xs font-medium">
          {(
            [
              ["internal", "Bliss-Work"],
              ["external", "External"],
              ["walink", "WhatsApp"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setMode(value)}
              className={`flex-1 rounded-lg py-1.5 transition-colors ${mode === value ? "bg-surface text-fg shadow-sm" : "text-muted"}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {mode === "internal" && <InternalForward sourceMessageId={sourceMessageId} onDone={onClose} />}
      {mode === "external" && <ExternalForward sourceMessageId={sourceMessageId} onDone={onClose} />}
      {mode === "walink" && (
        <WhatsAppForward
          sourceMessageId={sourceMessageId}
          sourceBody={preview ?? ""}
          onDone={onClose}
        />
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
