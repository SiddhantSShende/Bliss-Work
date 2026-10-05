import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MessageSquare, NotebookPen } from "lucide-react";
import { Avatar, Button, EmptyState, Spinner } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { useUserLabels } from "../lib/userLabel";

/**
 * What a meeting produced in writing: its chat, and its shared notes.
 *
 * Both used to exist only on the SFU's data channel and in each participant's
 * own localStorage, so a meeting that was over had nothing to read — see
 * messaging-svc migration 0029. These render the server copy, which is what
 * survives signing out, changing device, and not having been in the room.
 *
 * One component for both because they are the same shape — an author, a time
 * and a line of text, oldest first, paged forwards — and two near-identical
 * lists would be two places to fix the next thing either of them needs.
 *
 * ── Paged forwards ───────────────────────────────────────────────────────────
 * Unlike every other history in this product, a transcript is read from the
 * start: it is a conversation, not a feed. So "load more" appends to the END,
 * and the first page is the beginning of the meeting rather than its last
 * moments.
 */
type Entry = { id: string; who: string; at: string; text: string };

export function MeetingChatPanel({ callId }: { callId: string }) {
  const { t } = useTranslation("meetings");
  const { api } = useRuntime();
  const q = useInfiniteQuery({
    queryKey: qk.callChat(callId),
    queryFn: ({ pageParam }) => api.callChat(callId, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const entries: Entry[] = (q.data?.pages ?? []).flatMap((p) =>
    p.items.map((m) => ({ id: m.id, who: m.senderId, at: m.sentAt, text: m.text })),
  );
  return (
    <TranscriptList
      entries={entries}
      state={q}
      icon={<MessageSquare size={24} />}
      emptyTitle={t("transcript.chat.emptyTitle")}
      emptyHint={t("transcript.chat.emptyHint")}
    />
  );
}

export function MeetingNotesPanel({ callId }: { callId: string }) {
  const { t } = useTranslation("meetings");
  const { api } = useRuntime();
  const q = useInfiniteQuery({
    queryKey: qk.callNotes(callId),
    queryFn: ({ pageParam }) => api.callNotes(callId, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const entries: Entry[] = (q.data?.pages ?? []).flatMap((p) =>
    p.items.map((n) => ({ id: n.id, who: n.authorId, at: n.writtenAt, text: n.text })),
  );
  return (
    <TranscriptList
      entries={entries}
      state={q}
      icon={<NotebookPen size={24} />}
      emptyTitle={t("transcript.notes.emptyTitle")}
      emptyHint={t("transcript.notes.emptyHint")}
    />
  );
}

/** The three states a transcript read can be in, narrowed to what this needs
 *  from useInfiniteQuery so the two callers above can hand theirs straight in. */
interface TranscriptState {
  isLoading: boolean;
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
  refetch: () => unknown;
}

function TranscriptList({
  entries,
  state,
  icon,
  emptyTitle,
  emptyHint,
}: {
  entries: readonly Entry[];
  state: TranscriptState;
  icon: React.ReactNode;
  emptyTitle: string;
  emptyHint: string;
}) {
  const { t, i18n } = useTranslation("meetings");
  // The authors, asked for as one set — see useUserLabels on why a per-row
  // lookup would be a request per row.
  const { nameOf, avatarUrlOf } = useUserLabels(entries.map((e) => e.who));

  if (state.isLoading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted">
        <Spinner /> {t("transcript.loading")}
      </div>
    );
  }
  if (state.isError) {
    return (
      <div className="m-2 flex flex-col items-center gap-3 rounded-xl border border-border/60 p-6 text-center">
        <div className="text-sm font-medium text-fg">{t("transcript.error")}</div>
        <Button size="sm" variant="secondary" onClick={() => void state.refetch()}>
          {t("transcript.retry")}
        </Button>
      </div>
    );
  }
  if (entries.length === 0) {
    return <EmptyState icon={icon} title={emptyTitle} hint={emptyHint} />;
  }

  return (
    <div className="space-y-3 p-1">
      {entries.map((e) => (
        <article key={e.id} className="flex gap-2.5">
          <Avatar name={nameOf(e.who)} src={avatarUrlOf(e.who)} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="truncate text-sm font-semibold text-fg">{nameOf(e.who)}</span>
              <time className="shrink-0 text-[11px] text-muted" dateTime={e.at}>
                {new Date(e.at).toLocaleTimeString(i18n.language, {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
            </div>
            {/* Always a text node, never markup: every line here was written by
                another participant. */}
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg/90">
              {e.text}
            </p>
          </div>
        </article>
      ))}
      {state.hasNextPage && (
        <div className="pt-1 text-center">
          <Button
            size="sm"
            variant="ghost"
            disabled={state.isFetchingNextPage}
            onClick={() => void state.fetchNextPage()}
          >
            {state.isFetchingNextPage ? t("transcript.loading") : t("transcript.loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
