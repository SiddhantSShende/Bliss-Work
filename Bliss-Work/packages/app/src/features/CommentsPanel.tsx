import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";
import { Avatar, Button, Spinner } from "@taskboard/ui";
import type { TaskCommentDTO } from "@taskboard/shared";
import { formatTaskInstant } from "../lib/taskDates";
import { useTaskComments, useTaskCommentReplies } from "./useTaskComments";

const MAX_COMMENT_LENGTH = 4_000;

/** One author line + body, shared by a top-level comment and a reply. */
function CommentRow({ comment, currentUserId }: { comment: TaskCommentDTO; currentUserId?: string }) {
  const { t } = useTranslation("stickies");
  const name = comment.authorDisplayName || comment.authorUsername;
  return (
    <div className="flex items-start gap-2 py-1.5">
      <Avatar name={name} size="sm" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-sm font-semibold text-fg">
            {name}
            {comment.authorId === currentUserId && (
              <span className="ml-1 font-normal text-muted">{t("comments.you")}</span>
            )}
          </span>
          <span className="text-xs text-muted">{formatTaskInstant(comment.createdAt)}</span>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm text-fg/90">{comment.body}</p>
      </div>
    </div>
  );
}

/** A text-only composer: Enter posts, Shift+Enter inserts a newline. Keeps
 *  the draft on a failed submit (a recoverable network error must not cost
 *  the author what they typed) and latches against a same-tick double-fire
 *  — `mutation.isPending` alone lags a render behind `mutate()`. */
function Composer({
  placeholder,
  busyLabel,
  postLabel,
  errorLabel,
  onSubmit,
}: {
  placeholder: string;
  busyLabel: string;
  postLabel: string;
  errorLabel: string;
  onSubmit: (body: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState(false);
  const [posting, setPosting] = useState(false);
  const inFlight = useRef(false);

  const submit = () => {
    const body = draft.trim();
    if (!body || inFlight.current) return;
    inFlight.current = true;
    setPosting(true);
    setFailed(false);
    onSubmit(body).then(
      () => setDraft(""),
      () => setFailed(true),
    ).finally(() => {
      inFlight.current = false;
      setPosting(false);
    });
  };

  return (
    <div className="mt-1.5 flex items-end gap-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        rows={1}
        maxLength={MAX_COMMENT_LENGTH}
        className="min-w-0 flex-1 resize-none rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
      />
      <Button size="sm" variant="subtle" disabled={!draft.trim() || posting} onClick={submit}>
        {posting ? busyLabel : postLabel}
      </Button>
      {failed && <p className="text-xs text-danger">{errorLabel}</p>}
    </div>
  );
}

/** One top-level comment plus its (lazily loaded, bounded) reply thread. */
function CommentThread({
  taskId,
  comment,
  currentUserId,
}: {
  taskId: string;
  comment: TaskCommentDTO;
  currentUserId?: string;
}) {
  const { t } = useTranslation("stickies");
  const [expanded, setExpanded] = useState(false);
  const { replies, isLoading, isError, hasMore, isLoadingMore, loadMore, retry, post } = useTaskCommentReplies(
    taskId,
    comment.id,
    expanded,
  );

  return (
    <li className="border-t border-border/50 py-2 first:border-t-0">
      <CommentRow comment={comment} currentUserId={currentUserId} />
      <div className="ml-9 flex items-center gap-3 text-xs">
        <button type="button" className="font-medium text-muted hover:text-fg" onClick={() => setExpanded((v) => !v)}>
          {t("comments.reply")}
        </button>
        {comment.replyCount > 0 && !expanded && (
          <button type="button" className="font-medium text-accent hover:underline" onClick={() => setExpanded(true)}>
            {t("comments.replyCount", { count: comment.replyCount })}
          </button>
        )}
      </div>
      {expanded && (
        <div className="ml-9 mt-1 border-l border-border/60 pl-3">
          {isLoading && (
            <p className="flex items-center gap-2 py-2 text-xs text-muted">
              <Spinner className="shrink-0" /> {t("comments.repliesLoading")}
            </p>
          )}
          {isError && replies.length === 0 && (
            <p className="flex items-center gap-2 py-2 text-xs text-danger" role="alert">
              <AlertCircle size={14} aria-hidden /> {t("comments.repliesError")}
              <button type="button" className="font-medium underline" onClick={retry}>
                {t("comments.retry")}
              </button>
            </p>
          )}
          <ul className="m-0 list-none p-0">
            {replies.map((r) => (
              <li key={r.id}>
                <CommentRow comment={r} currentUserId={currentUserId} />
              </li>
            ))}
          </ul>
          {hasMore && (
            <button
              type="button"
              disabled={isLoadingMore}
              className="py-1 text-xs font-medium text-accent hover:underline disabled:opacity-50"
              onClick={loadMore}
            >
              {isLoadingMore ? t("comments.loadingMore") : t("comments.loadMoreReplies")}
            </button>
          )}
          <Composer
            placeholder={t("comments.replyPlaceholder")}
            busyLabel={t("comments.posting")}
            postLabel={t("comments.post")}
            errorLabel={t("comments.postError")}
            onSubmit={(body) => post.mutateAsync(body)}
          />
        </div>
      )}
    </li>
  );
}

/**
 * Task-specific, text-only threaded comments — Reddit-style (top-level +
 * one level of replies), separate from Chat. Expands inline below a task's
 * action row (StickyWidget) in both the Tasks list and the desktop pin,
 * which share this exact component.
 *
 * Three top-level comments load up front, newest-first; "Load more" pages
 * in older ones. Bounded height with its own scroll: the floating desktop
 * pin's window cannot scroll itself (see StickyWidget's doc comment), so an
 * unbounded panel would silently push the action row off-screen instead.
 */
export function CommentsPanel({ taskId, currentUserId }: { taskId: string; currentUserId?: string }) {
  const { t } = useTranslation("stickies");
  const { comments, isLoading, isError, hasMore, isLoadingMore, loadMore, retry, post } = useTaskComments(
    taskId,
    true,
  );

  return (
    <div className="app-no-drag mt-2 flex flex-col gap-2 rounded-xl border border-border/60 bg-surface-1 p-3">
      <Composer
        placeholder={t("comments.placeholder")}
        busyLabel={t("comments.posting")}
        postLabel={t("comments.post")}
        errorLabel={t("comments.postError")}
        onSubmit={(body) => post.mutateAsync(body)}
      />
      <div className="max-h-72 overflow-y-auto">
        {isLoading ? (
          <p className="flex items-center gap-2 py-3 text-sm text-muted">
            <Spinner className="shrink-0" /> {t("comments.loading")}
          </p>
        ) : isError && comments.length === 0 ? (
          <p className="flex items-center gap-2 py-3 text-sm text-danger" role="alert">
            <AlertCircle size={16} aria-hidden /> {t("comments.loadError")}
            <button type="button" className="font-medium underline" onClick={retry}>
              {t("comments.retry")}
            </button>
          </p>
        ) : comments.length === 0 ? (
          <p className="py-3 text-center text-sm text-muted">{t("comments.empty")}</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {comments.map((c) => (
              <CommentThread key={c.id} taskId={taskId} comment={c} currentUserId={currentUserId} />
            ))}
          </ul>
        )}
        {hasMore && (
          <button
            type="button"
            disabled={isLoadingMore}
            className="w-full py-2 text-xs font-medium text-accent hover:underline disabled:opacity-50"
            onClick={loadMore}
          >
            {isLoadingMore ? t("comments.loadingMore") : t("comments.loadMore")}
          </button>
        )}
      </div>
    </div>
  );
}
