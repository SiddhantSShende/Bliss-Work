import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Check, Forward, Hash, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Avatar, Button, Input } from "@taskboard/ui";
import type { ForwardDestinationResultDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { matchUser } from "../lib/matchUser";
import { readablePrefix } from "../lib/chatEnvelope";
import { useSelectedChat } from "../lib/selectedChat";
import { useToggleSet } from "../lib/useToggleSet";
import { Modal } from "./Modal";

/**
 * Forward one or more messages to one or more chats/channels INSIDE the
 * workspace.
 *
 * The sibling dialog (ForwardDialog) hands a message to WhatsApp and can only
 * ever record that it opened. This one delivers: the server writes a copy
 * into every destination and re-scopes any attachments each source carries,
 * so a forwarded photo opens for the recipient instead of rendering as a file
 * they cannot fetch.
 *
 * That re-scoping is the reason this is a server call rather than "read the
 * body and send it again from here" — an attachment id is authorized against
 * the conversation it was uploaded to, so a client-side copy would deliver
 * ids the recipient is not allowed to read.
 *
 * Multi-source, multi-destination: a single-message forward is simply a batch
 * of one message — there is no second code path. Selecting multiple
 * destinations was previously refused here on the grounds that a misclick
 * would land in several places at once with nothing here able to unsend it;
 * that risk is now surfaced instead as a clear "N destinations" confirm
 * button and a post-submit report of exactly which destinations it reached.
 */
type Target =
  | { kind: "user"; id: string; label: string }
  | { kind: "channel"; id: string; label: string };

function targetKey(kind: "user" | "channel", id: string) {
  return `${kind}:${id}`;
}

export function ForwardToDialog({
  open,
  onClose,
  sourceMessageIds,
  preview,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  /** The messages to forward, in whatever order the caller has them in — the
   *  SERVER re-sorts by canonical seq before delivering, so this order does
   *  not need to be chronological itself. A single-message forward is just a
   *  one-element array. */
  sourceMessageIds: string[];
  /** The FIRST source's raw body — shown as a readable prefix, so a media
   *  message reads "🖼️ 3 photos" rather than its envelope JSON. */
  preview?: string;
  /** Fired once the batch has been attempted, win or lose per-destination —
   *  the operation completed either way, and the toast carries the detail.
   *  Lets a bulk-selection caller exit selection mode. */
  onDone?: () => void;
}) {
  const { t } = useTranslation("chatList");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { openChat } = useSelectedChat();
  const me = useSession((s) => s.user);
  const [query, setQuery] = useState("");
  const { selected, setSelected, toggle } = useToggleSet();
  // Minted on first submit, reused across a retry of the SAME submission so
  // the server's derived per-(message, destination) idempotency key stays
  // stable — a retry after a dropped connection then re-uses whatever already
  // landed instead of delivering a second copy.
  const batchIdRef = useRef<string | null>(null);

  // A dialog reopened on a different selection of messages must not keep the
  // previous destinations: the confirm button would then forward THESE
  // messages to destinations picked for a different selection.
  const sourceKey = sourceMessageIds.join(",");
  useEffect(() => {
    setQuery("");
    setSelected(new Set());
    batchIdRef.current = null;
  }, [sourceKey, setSelected]);

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

  // Resolves a key back to a Target with its label, from the UNFILTERED
  // lists — so a destination chosen before a search narrowed it down (or one
  // reported back after a submit) still has a name to show, not just an id.
  const labelOf = (key: string): Target | null => {
    const [kind, id] = key.split(":") as ["user" | "channel", string];
    if (kind === "user") {
      const u = people.find((p) => p.id === id);
      return u ? { kind, id, label: u.displayName || u.username } : null;
    }
    const c = channels.find((ch) => ch.id === id);
    return c ? { kind, id, label: `#${c.name}` } : null;
  };

  const forward = useMutation({
    mutationFn: (targets: Target[]) => {
      if (sourceMessageIds.length === 0) throw new Error("no message");
      batchIdRef.current ??= crypto.randomUUID();
      return api.forwardMessages({
        messageIds: sourceMessageIds,
        targets: targets.map((t) => ({ kind: t.kind, id: t.id })),
        clientBatchId: batchIdRef.current,
      });
    },
    onSuccess: (res) => {
      // The copies land in conversations/channels that are very likely not
      // the one on screen, so nothing refreshes them unless we ask. A
      // destination may also be brand new — forwarding to someone never
      // messaged before creates the chat — which is why the lists are
      // invalidated too.
      void qc.invalidateQueries({ queryKey: qk.conversations });
      void qc.invalidateQueries({ queryKey: qk.channels });
      void qc.invalidateQueries({ queryKey: ["messages"] });
      void qc.invalidateQueries({ queryKey: ["channelMessages"] });

      const describe = (d: ForwardDestinationResultDTO) =>
        labelOf(targetKey(d.targetKind, d.targetId))?.label ??
        (d.targetKind === "channel" ? t("forwardTo.fallbackChannel") : t("forwardTo.fallbackPerson"));
      const ok = res.results.filter((d) => d.ok);
      const bad = res.results.filter((d) => !d.ok);

      if (bad.length === 0 && ok.length === 1) {
        // Keep the single-destination nicety: somewhere to go, one click away.
        const only = ok[0]!;
        const openTarget = only.channelId
          ? () => navigate(`/app/channels/${only.channelId}`)
          : only.conversationId
            ? () => openChat(only.conversationId!)
            : null;
        toast.success(t("forwardTo.toasts.oneSuccess", { destination: describe(only) }), {
          ...(openTarget && { action: { label: t("forwardTo.toasts.openAction"), onClick: openTarget } }),
        });
      } else if (bad.length === 0) {
        toast.success(t("forwardTo.toasts.allSuccess", { count: ok.length }));
      } else if (ok.length === 0) {
        toast.error(t("forwardTo.toasts.allFailed", { count: bad.length }), {
          description: bad.map(describe).join(", "),
        });
      } else {
        toast.warning(t("forwardTo.toasts.partialSuccess", { count: ok.length }), {
          description: t("forwardTo.toasts.partialFailedDescription", { count: bad.length, list: bad.map(describe).join(", ") }),
        });
      }
      onDone?.();
      onClose();
    },
    onError: (err: unknown) => {
      // A whole-request failure: a source the caller cannot read, or (for a
      // bulk selection) one spanning more than one chat/channel. Individual
      // destination refusals arrive in the success body above, not here.
      const message = err instanceof Error ? err.message : "";
      toast.error(t("forwardTo.toasts.genericError.title"), {
        description: message || t("forwardTo.toasts.genericError.description"),
      });
    },
  });

  const row =
    "flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm transition-colors";

  const selectedTargets = useMemo(
    () => [...selected].map(labelOf).filter((t): t is Target => t !== null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, people, channels],
  );

  return (
    <Modal
      open={open && sourceMessageIds.length > 0}
      onClose={onClose}
      title={sourceMessageIds.length > 1 ? t("forwardTo.titleMultiple", { count: sourceMessageIds.length }) : t("forwardTo.titleSingle")}
    >
      {preview && (
        <div className="mb-3 flex items-start gap-2 rounded-xl bg-surface-2 p-2.5 text-xs text-muted">
          <Forward size={14} className="mt-0.5 shrink-0 text-accent" />
          <span className="line-clamp-2 break-words">
            {sourceMessageIds.length > 1 && t("forwardTo.messagesPrefix", { count: sourceMessageIds.length })}
            {readablePrefix(preview) || preview}
          </span>
        </div>
      )}

      <div className="relative mb-2">
        <Search
          size={15}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
        />
        <Input
          className="h-9 pl-9"
          placeholder={t("forwardTo.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>

      {selected.size > 0 && (
        <div className="mb-2 flex items-center justify-between px-1 text-xs text-muted">
          <span>{t("forwardTo.selectedCount", { count: selected.size })}</span>
          <button
            type="button"
            className="font-medium text-accent hover:text-accent-strong"
            onClick={() => setSelected(new Set())}
          >
            {t("forwardTo.clearSelection")}
          </button>
        </div>
      )}

      <div className="max-h-64 space-y-2 overflow-auto">
        {matches.people.length === 0 && matches.channels.length === 0 && (
          <p className="px-1 py-6 text-center text-xs text-muted">{t("forwardTo.noMatches")}</p>
        )}

        {matches.people.length > 0 && (
          <section>
            <h3 className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
              {t("forwardTo.peopleHeading")}
            </h3>
            {matches.people.map((u) => {
              const key = targetKey("user", u.id);
              const on = selected.has(key);
              return (
                <button
                  key={u.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(key)}
                  className={`${row} ${on ? "bg-accent-soft text-accent" : "text-fg hover:bg-surface-2"}`}
                >
                  <Avatar name={u.displayName || u.username} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{u.displayName || u.username}</span>
                  {on && <Check size={15} className="shrink-0 text-accent" />}
                </button>
              );
            })}
          </section>
        )}

        {matches.channels.length > 0 && (
          <section>
            <h3 className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
              {t("forwardTo.channelsHeading")}
            </h3>
            {matches.channels.map((c) => {
              const key = targetKey("channel", c.id);
              const on = selected.has(key);
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(key)}
                  className={`${row} ${on ? "bg-accent-soft text-accent" : "text-fg hover:bg-surface-2"}`}
                >
                  <Hash size={15} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  {on && <Check size={15} className="shrink-0 text-accent" />}
                </button>
              );
            })}
          </section>
        )}
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onClose} disabled={forward.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          size="sm"
          disabled={selected.size === 0 || forward.isPending}
          onClick={() => forward.mutate(selectedTargets)}
        >
          {forward.isPending ? <Loader2 size={14} className="animate-spin" /> : <Forward size={14} />}
          {selected.size === 1 && selectedTargets[0]
            ? t("forwardTo.forwardToOne", { name: selectedTargets[0].label })
            : selected.size > 1
              ? t("forwardTo.forwardToMany", { count: selected.size })
              : t("forwardTo.forwardDefault")}
        </Button>
      </div>
    </Modal>
  );
}
