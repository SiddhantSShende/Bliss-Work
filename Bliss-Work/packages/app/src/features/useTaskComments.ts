import { useMemo } from "react";
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { TaskCommentDTO, TaskCommentPage } from "@taskboard/shared";
import { useRuntimeOptional } from "../lib/runtime";
import { qk } from "../lib/queryKeys";

const TOP_LEVEL_PAGE_SIZE = 3;
const REPLIES_PAGE_SIZE = 10;

/** IPC-backed stand-in for the ApiClient's comment methods, used only where
 *  there is no RuntimeProvider — the Electron floating note window (see
 *  StickyWidget's doc comment on CommentsPanel). Main relays these through
 *  ws-process, the one process that holds a real authenticated ApiClient;
 *  see apps/desktop/src/main/index.ts's requestComments and
 *  ws-process.ts's "comments" case. */
interface StickyCommentsBridge {
  list: (taskId: string, cursor: string | null, limit: number) => Promise<TaskCommentPage>;
  post: (taskId: string, body: string) => Promise<TaskCommentDTO>;
  replies: (taskId: string, commentId: string, cursor: string | null, limit: number) => Promise<TaskCommentPage>;
  postReply: (taskId: string, commentId: string, body: string) => Promise<TaskCommentDTO>;
}

function stickyCommentsBridge(): StickyCommentsBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { sticky?: { comments?: StickyCommentsBridge } };
  return w.sticky?.comments ?? null;
}

/** Prepend `created` to the first (newest) page — mirrors the server's own
 *  newest-first ordering. No-op if the thread was never fetched (the
 *  composer only exists once the panel — and so the query — is open). */
function prependTopLevel(
  old: InfiniteData<TaskCommentPage> | undefined,
  created: TaskCommentDTO,
): InfiniteData<TaskCommentPage> | undefined {
  if (!old) return old;
  const pages = [...old.pages];
  pages[0] = { ...pages[0]!, comments: [created, ...pages[0]!.comments] };
  return { ...old, pages };
}

/**
 * Top-level comments thread for one task (CommentsPanel). Three load up
 * front; `loadMore` pages in older ones via the server's keyset cursor —
 * see task-svc's routes/tasks_comments.py for why that (not OFFSET) is what
 * keeps an already-loaded page stable while the thread is open.
 *
 * `post`'s success handler inserts the new comment directly into the cache
 * rather than invalidating: the author must see their own comment
 * immediately with no duplicate, and queryBridge.tsx deliberately skips the
 * WS echo for the author for exactly this reason.
 */
export function useTaskComments(taskId: string, enabled: boolean) {
  const runtime = useRuntimeOptional();
  const bridge = runtime ? null : stickyCommentsBridge();
  const qc = useQueryClient();

  const query = useInfiniteQuery({
    queryKey: qk.taskComments(taskId),
    queryFn: ({ pageParam }) =>
      runtime
        ? runtime.api.taskComments(taskId, { cursor: pageParam, limit: TOP_LEVEL_PAGE_SIZE })
        : bridge!.list(taskId, pageParam, TOP_LEVEL_PAGE_SIZE),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor ?? null : undefined),
    enabled: enabled && (!!runtime || !!bridge),
  });

  const comments = useMemo(() => query.data?.pages.flatMap((p) => p.comments) ?? [], [query.data]);

  const post = useMutation({
    mutationFn: (body: string) => (runtime ? runtime.api.createTaskComment(taskId, body) : bridge!.post(taskId, body)),
    onSuccess: (created) => {
      qc.setQueryData<InfiniteData<TaskCommentPage>>(qk.taskComments(taskId), (old) => prependTopLevel(old, created));
    },
  });

  return {
    comments,
    isLoading: query.isLoading,
    isError: query.isError,
    hasMore: !!query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
    retry: () => void query.refetch(),
    post,
  };
}

/**
 * Replies to one TOP-LEVEL comment, oldest-first (natural reading order) —
 * same cursor pattern as useTaskComments, loaded only once the comment is
 * expanded (`enabled`).
 */
export function useTaskCommentReplies(taskId: string, commentId: string, enabled: boolean) {
  const runtime = useRuntimeOptional();
  const bridge = runtime ? null : stickyCommentsBridge();
  const qc = useQueryClient();

  const query = useInfiniteQuery({
    queryKey: qk.taskCommentReplies(taskId, commentId),
    queryFn: ({ pageParam }) =>
      runtime
        ? runtime.api.taskCommentReplies(taskId, commentId, { cursor: pageParam, limit: REPLIES_PAGE_SIZE })
        : bridge!.replies(taskId, commentId, pageParam, REPLIES_PAGE_SIZE),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor ?? null : undefined),
    enabled: enabled && (!!runtime || !!bridge),
  });

  const replies = useMemo(() => query.data?.pages.flatMap((p) => p.comments) ?? [], [query.data]);

  const post = useMutation({
    mutationFn: (body: string) =>
      runtime ? runtime.api.createTaskCommentReply(taskId, commentId, body) : bridge!.postReply(taskId, commentId, body),
    onSuccess: (created) => {
      // A new reply belongs at the END of the last loaded page (oldest-first).
      qc.setQueryData<InfiniteData<TaskCommentPage>>(qk.taskCommentReplies(taskId, commentId), (old) => {
        if (!old) return old;
        const pages = [...old.pages];
        const lastIndex = pages.length - 1;
        pages[lastIndex] = { ...pages[lastIndex]!, comments: [...pages[lastIndex]!.comments, created] };
        return { ...old, pages };
      });
      // Bump the parent's replyCount in the top-level list so "N replies" is
      // correct immediately, without waiting for a refetch.
      qc.setQueryData<InfiniteData<TaskCommentPage>>(qk.taskComments(taskId), (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            comments: page.comments.map((c) =>
              c.id === commentId ? { ...c, replyCount: c.replyCount + 1 } : c,
            ),
          })),
        };
      });
    },
  });

  return {
    replies,
    isLoading: query.isLoading,
    isError: query.isError,
    hasMore: !!query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
    retry: () => void query.refetch(),
    post,
  };
}
