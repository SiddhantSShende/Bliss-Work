import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Forward, Hash, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Avatar, Button, Input } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { matchUser } from "../lib/matchUser";
import { readablePrefix } from "../lib/chatEnvelope";
import { Modal } from "./Modal";

/**
 * Forward a message to another chat or channel INSIDE the workspace.
 *
 * The sibling dialog (ForwardDialog) hands the message to WhatsApp and can only
 * ever record that it opened. This one delivers: the server writes the copy into
 * the destination and re-scopes any attachments it carries, so a forwarded photo
 * opens for the recipient instead of rendering as a file they cannot fetch.
 *
 * That re-scoping is the reason this is a server call rather than "read the body
 * and send it again from here" — an attachment id is authorized against the
 * conversation it was uploaded to, so a client-side copy would deliver ids the
 * recipient is not allowed to read.
 *
 * One destination at a time, deliberately. Multi-select turns a misclick into
 * several messages in several places, none of which can be unsent from here.
 */
type Target =
  | { kind: "user"; id: string; label: string }
  | { kind: "channel"; id: string; label: string };

export function ForwardToDialog({
  open,
  onClose,
  sourceMessageId,
  preview,
}: {
  open: boolean;
  onClose: () => void;
  sourceMessageId: string | null;
  /** The source message's raw body — shown as the readable prefix, so a media
   *  message reads "🖼️ 3 photos" rather than its envelope JSON. */
  preview?: string;
}) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useSession((s) => s.user);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<Target | null>(null);

  // A dialog reopened on a different message must not keep the previous
  // selection: the confirm button would then forward THIS message to a
  // destination the user picked for another one.
  useEffect(() => {
    setQuery("");
    setTarget(null);
  }, [sourceMessageId]);

  const { data: people = [] } = useQuery({
    queryKey: qk.directory,
    queryFn: () => api.directory(),
    enabled: open,
  });
  const { data: channels = [] } = useQuery({
    queryKey: qk.channels,
    queryFn: () => api.channels(),
    enabled: open,
  });

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return {
      people: people.filter((u) => u.id !== me?.id && matchUser(u, query)),
      // Only channels the caller is IN. A channel they merely browse would 403
      // on the forward, and a row that always fails is worse than no row.
      channels: channels.filter((c) => c.name.toLowerCase().includes(q)),
    };
  }, [people, channels, query, me?.id]);

  const forward = useMutation({
    mutationFn: async (to: Target) => {
      if (!sourceMessageId) throw new Error("no message");
      return api.forwardMessage(sourceMessageId, { kind: to.kind, id: to.id });
    },
    onSuccess: (res, to) => {
      // The copy lands in a conversation or channel that is very likely not the
      // one on screen, so nothing refreshes it unless we ask. The destination
      // may also be brand new — forwarding to someone you have never messaged
      // creates the chat — which is why the lists are invalidated too.
      void qc.invalidateQueries({ queryKey: qk.conversations });
      void qc.invalidateQueries({ queryKey: qk.channels });
      void qc.invalidateQueries({ queryKey: ["messages"] });
      void qc.invalidateQueries({ queryKey: ["channelMessages"] });
      const to_ = res.channelId
        ? `/app/channels/${res.channelId}`
        : res.conversationId
          ? `/app/chats/${res.conversationId}`
          : null;
      toast.success(`Forwarded to ${to.label}`, {
        ...(to_ && { action: { label: "Open", onClick: () => navigate(to_) } }),
      });
      onClose();
    },
    onError: (err: unknown) => {
      // The server refuses a destination the caller cannot post to (not a
      // member, blocked, deactivated peer). Say so rather than "failed": the
      // user picked a name from a list and deserves to know why it bounced.
      const message = err instanceof Error ? err.message : "";
      toast.error("Couldn't forward that message", {
        description: message || "You may not be able to post in that destination.",
      });
    },
  });

  const row =
    "flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm transition-colors";

  return (
    <Modal open={!!sourceMessageId && open} onClose={onClose} title="Forward to…">
      {preview && (
        <div className="mb-3 flex items-start gap-2 rounded-xl bg-surface-2 p-2.5 text-xs text-muted">
          <Forward size={14} className="mt-0.5 shrink-0 text-accent" />
          <span className="line-clamp-2 break-words">{readablePrefix(preview) || preview}</span>
        </div>
      )}

      <div className="relative mb-2">
        <Search
          size={15}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
        />
        <Input
          className="h-9 pl-9"
          placeholder="Search people and channels…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>

      <div className="max-h-64 space-y-2 overflow-auto">
        {matches.people.length === 0 && matches.channels.length === 0 && (
          <p className="px-1 py-6 text-center text-xs text-muted">No people or channels match.</p>
        )}

        {matches.people.length > 0 && (
          <section>
            <h3 className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
              People
            </h3>
            {matches.people.map((u) => {
              const selected = target?.kind === "user" && target.id === u.id;
              return (
                <button
                  key={u.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    setTarget({ kind: "user", id: u.id, label: u.displayName || u.username })
                  }
                  className={`${row} ${selected ? "bg-accent-soft text-accent" : "text-fg hover:bg-surface-2"}`}
                >
                  <Avatar name={u.displayName || u.username} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{u.displayName || u.username}</span>
                </button>
              );
            })}
          </section>
        )}

        {matches.channels.length > 0 && (
          <section>
            <h3 className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
              Channels
            </h3>
            {matches.channels.map((c) => {
              const selected = target?.kind === "channel" && target.id === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setTarget({ kind: "channel", id: c.id, label: `#${c.name}` })}
                  className={`${row} ${selected ? "bg-accent-soft text-accent" : "text-fg hover:bg-surface-2"}`}
                >
                  <Hash size={15} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                </button>
              );
            })}
          </section>
        )}
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!target || forward.isPending}
          onClick={() => target && forward.mutate(target)}
        >
          {forward.isPending ? <Loader2 size={14} className="animate-spin" /> : <Forward size={14} />}
          {target ? `Forward to ${target.label}` : "Forward"}
        </Button>
      </div>
    </Modal>
  );
}
