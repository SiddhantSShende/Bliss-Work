/**
 * Hub mentions — "someone tagged me on a connected platform".
 *
 * Deliberately NOT a feed of everything happening on your connected accounts:
 * only messages that name you appear here, each with two actions. Claim turns
 * the mention into a task allocated to you (after which the normal task flow
 * applies); Ignore dismisses it for good.
 *
 * Both actions patch the list optimistically and roll back on failure. The
 * server is idempotent for both, so a double-click or a retry after a dropped
 * response can never produce two tasks — the buttons are still disabled while
 * in flight so the UI doesn't imply otherwise.
 */
import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  AtSign,
  Check,
  ExternalLink,
  Loader2,
  Mail,
  MessageCircle,
  Slack,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button, EmptyState } from "@taskboard/ui";
import { ApiError, type MentionDTO, type MentionState } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { countMentions, dropMention, flatMentions, type MentionPages } from "../lib/mentionPatch";

const TABS: { key: MentionState; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "claimed", label: "Claimed" },
  { key: "ignored", label: "Dismissed" },
];

const PROVIDER_ICON: Record<string, React.ReactNode> = {
  slack: <Slack size={14} />,
  gmail: <Mail size={14} />,
  outlook: <Mail size={14} />,
  teams: <Users size={14} />,
};

export function HubMentions() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [tab, setTab] = useState<MentionState>("pending");
  const [busyId, setBusyId] = useState<string | null>(null);

  const query = useInfiniteQuery({
    queryKey: qk.mentions(tab),
    queryFn: ({ pageParam }) => api.mentions(tab, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Live-pushed via integration.mention.created; poll as a fallback in case a
    // socket is asleep or a push notification was dropped by the provider.
    refetchInterval: 60_000,
  });

  // Handles decide which mentions are "mine", so an empty list is the most
  // likely reason a user sees nothing — worth saying so rather than
  // showing a bare "nothing here".
  const { data: identities = [] } = useQuery({
    queryKey: qk.providerIdentities,
    queryFn: () => api.providerIdentities(),
    retry: 1,
  });

  const items = flatMentions(query.data as MentionPages | undefined);

  /** Shared optimistic scaffolding: pull the row out, restore it on failure.
   *  Each mutation adds its own onSuccess on top. */
  const optimistic = (failure: string) => ({
    onMutate: async (id: string) => {
      setBusyId(id);
      await qc.cancelQueries({ queryKey: qk.mentions(tab) });
      const prev = qc.getQueryData<MentionPages>(qk.mentions(tab));
      qc.setQueryData<MentionPages>(qk.mentions(tab), (d) => dropMention(d, id));
      return { prev };
    },
    onError: (err: unknown, _id: string, ctx?: { prev?: MentionPages }) => {
      // A 409 means the server already settled this mention some other way
      // (another device claimed it, or it was dismissed). Restoring the stale
      // row would lie — refetch so the user sees the real state.
      if (err instanceof ApiError && err.status === 409) {
        toast.error("Already handled", { description: err.message });
        void qc.invalidateQueries({ queryKey: ["mentions"] });
        return;
      }
      if (ctx?.prev) qc.setQueryData(qk.mentions(tab), ctx.prev);
      toast.error(failure, { description: "Please try again." });
    },
    onSettled: () => {
      setBusyId(null);
      // Every tab: the row moved BETWEEN tabs, so refreshing only this one
      // would leave the destination stale.
      void qc.invalidateQueries({ queryKey: ["mentions"] });
    },
  });

  const claim = useMutation({
    mutationFn: (id: string) => api.claimMention(id),
    ...optimistic("Couldn't claim this mention"),
    onSuccess: () => {
      toast.success("Task created", {
        description: "Allocated to you — find it under Tasks.",
      });
      // The new task is assigned to the caller, so their own task surfaces
      // (task inbox, allocated list, desktop stickies, unified inbox) are stale.
      void qc.invalidateQueries({ queryKey: qk.inbox });
      void qc.invalidateQueries({ queryKey: qk.assigned });
      void qc.invalidateQueries({ queryKey: qk.sticky });
      void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
    },
  });

  const ignore = useMutation({
    mutationFn: (id: string) => api.ignoreMention(id),
    ...optimistic("Couldn't dismiss this mention"),
    onSuccess: () => toast("Dismissed"),
  });

  const pendingCount = tab === "pending" ? countMentions(query.data as MentionPages | undefined) : 0;

  return (
    <section>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-fg">
        <AtSign size={16} className="text-accent" /> Mentions
      </h2>
      <p className="mb-3 text-xs text-muted">
        Only messages where someone tagged you on a connected account. Claim one to turn it into a
        task allocated to you.
      </p>

      <div className="mb-3 flex flex-wrap gap-1 rounded-xl bg-surface-2 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              tab === t.key ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
            }`}
          >
            {t.label}
            {t.key === "pending" && pendingCount > 0 && (
              <span className="ml-1.5 rounded-full bg-accent px-1.5 py-0.5 text-[10px] text-white">
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {query.isError ? (
        <div className="rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning">
          The integrations service is unreachable right now.
        </div>
      ) : query.isLoading ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <div className="glass rounded-2xl p-6">
          <EmptyState
            icon={<AtSign size={22} />}
            title={tab === "pending" ? "No one has tagged you yet" : `Nothing ${tab}`}
            hint={
              tab === "pending" && identities.length === 0
                ? "Add your handles below so we know which mentions are yours."
                : "When someone @-mentions you on a connected account, it lands here."
            }
          />
        </div>
      ) : (
        <>
          <div className="glass divide-y divide-border/50 overflow-hidden rounded-2xl">
            {items.map((m) => (
              <MentionRow
                key={m.id}
                mention={m}
                busy={busyId === m.id}
                disabled={claim.isPending || ignore.isPending}
                onClaim={() => claim.mutate(m.id)}
                onIgnore={() => ignore.mutate(m.id)}
              />
            ))}
          </div>
          {query.hasNextPage && (
            <div className="mt-3 flex justify-center">
              <Button
                variant="subtle"
                size="sm"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  "Load more"
                )}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function MentionRow({
  mention: m,
  busy,
  disabled,
  onClaim,
  onIgnore,
}: {
  mention: MentionDTO;
  busy: boolean;
  disabled: boolean;
  onClaim: () => void;
  onIgnore: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
        {PROVIDER_ICON[m.provider] ?? <AtSign size={14} />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="font-medium capitalize text-fg">{m.provider}</span>
          <span aria-hidden>·</span>
          <span className="truncate">from {m.peer || "someone"}</span>
          <span aria-hidden>·</span>
          <time dateTime={m.occurredAt}>{new Date(m.occurredAt).toLocaleString()}</time>
        </div>
        <div className="mt-0.5 break-words text-sm text-fg">{m.body || "—"}</div>

        <div className="mt-1 flex flex-wrap items-center gap-3">
          {m.permalink && (
            <a
              href={m.permalink}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
            >
              <ExternalLink size={11} /> View on {m.provider}
            </a>
          )}
          {m.state === "claimed" && m.taskId && (
            <Link
              to={`/app/inbox/task/${m.taskId}`}
              className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
            >
              <Check size={11} /> View task
            </Link>
          )}
        </div>
      </div>

      {m.state === "pending" && (
        <div className="flex shrink-0 gap-2 sm:pt-0.5">
          <Button size="sm" disabled={disabled} onClick={onClaim}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : "Claim"}
          </Button>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={onIgnore}>
            <X size={14} className="mr-1" /> Ignore
          </Button>
        </div>
      )}
    </div>
  );
}
