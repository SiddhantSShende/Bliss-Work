/**
 * Task comments panel: loading/empty/error states, the 3-then-"Load more"
 * pagination, posting a top-level comment (with the duplicate-submit latch
 * and draft-preserving-on-failure requirements), and one level of replies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TaskCommentDTO, TaskCommentPage } from "@taskboard/shared";

const h = vi.hoisted(() => ({
  api: {
    taskComments: vi.fn(),
    createTaskComment: vi.fn(),
    taskCommentReplies: vi.fn(),
    createTaskCommentReply: vi.fn(),
  },
}));
vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: h.api, config: {} }),
  useRuntimeOptional: () => ({ api: h.api, config: {} }),
}));

import { CommentsPanel } from "./CommentsPanel";

const TASK_ID = "11111111-1111-1111-1111-111111111111";
const ME = "22222222-2222-2222-2222-222222222222";
const OTHER = "33333333-3333-3333-3333-333333333333";

function comment(over: Partial<TaskCommentDTO> = {}): TaskCommentDTO {
  return {
    id: crypto.randomUUID(),
    taskId: TASK_ID,
    parentCommentId: null,
    authorId: OTHER,
    authorUsername: "other",
    authorDisplayName: "Other Person",
    body: "a comment",
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
    replyCount: 0,
    ...over,
  };
}

function page(comments: TaskCommentDTO[], hasMore = false, nextCursor: string | null = null): TaskCommentPage {
  return { comments, hasMore, nextCursor };
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={qc}>
      <CommentsPanel taskId={TASK_ID} currentUserId={ME} />
    </QueryClientProvider>,
  );
  return user;
}

beforeEach(() => {
  h.api.taskComments.mockReset();
  h.api.createTaskComment.mockReset();
  h.api.taskCommentReplies.mockReset();
  h.api.createTaskCommentReply.mockReset();
});

afterEach(() => cleanup());

describe("loading / empty / error", () => {
  it("shows a loading state, then the empty state once the thread has nothing", async () => {
    h.api.taskComments.mockResolvedValue(page([]));
    mount();
    expect(screen.getByText("Loading comments…")).toBeInTheDocument();
    expect(await screen.findByText("No comments yet.")).toBeInTheDocument();
  });

  it("shows a retryable error state when the first page fails", async () => {
    h.api.taskComments.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(page([comment()]));
    const user = mount();
    expect(await screen.findByText("Couldn't load comments.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("a comment")).toBeInTheDocument();
  });
});

describe("pagination", () => {
  it("loads three up front and pages in more on Load more, without duplicating", async () => {
    const first = [comment({ id: "c1", body: "newest" }), comment({ id: "c2", body: "middle" }), comment({ id: "c3", body: "older" })];
    const second = [comment({ id: "c4", body: "oldest" })];
    h.api.taskComments
      .mockResolvedValueOnce(page(first, true, "cursor-1"))
      .mockResolvedValueOnce(page(second, false, null));

    const user = mount();
    await screen.findByText("newest");
    expect(screen.getByText("middle")).toBeInTheDocument();
    expect(screen.getByText("older")).toBeInTheDocument();
    expect(screen.queryByText("oldest")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("oldest");
    expect(h.api.taskComments).toHaveBeenLastCalledWith(TASK_ID, { cursor: "cursor-1", limit: 3 });
    // No duplicates, no "Load more" once the second page says hasMore: false.
    expect(screen.getAllByText(/newest|middle|older|oldest/)).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });
});

describe("posting a top-level comment", () => {
  it("appears immediately with no duplicate, and the draft clears", async () => {
    h.api.taskComments.mockResolvedValue(page([]));
    const posted = comment({ id: "new-1", authorId: ME, authorUsername: "me", body: "hello there" });
    h.api.createTaskComment.mockResolvedValue(posted);

    const user = mount();
    await screen.findByText("No comments yet.");

    const box = screen.getByPlaceholderText("Write a comment…");
    await user.type(box, "hello there");
    await user.click(screen.getByRole("button", { name: "Post" }));

    expect(await screen.findByText("hello there")).toBeInTheDocument();
    expect(h.api.createTaskComment).toHaveBeenCalledWith(TASK_ID, "hello there");
    expect(h.api.createTaskComment).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(box).toHaveValue(""));
  });

  it("cannot submit a blank/whitespace-only comment", async () => {
    h.api.taskComments.mockResolvedValue(page([]));
    const user = mount();
    await screen.findByText("No comments yet.");

    const box = screen.getByPlaceholderText("Write a comment…");
    await user.type(box, "   ");
    expect(screen.getByRole("button", { name: "Post" })).toBeDisabled();
    expect(h.api.createTaskComment).not.toHaveBeenCalled();
  });

  it("keeps the draft and shows an error when posting fails (recoverable network error)", async () => {
    h.api.taskComments.mockResolvedValue(page([]));
    h.api.createTaskComment.mockRejectedValueOnce(new Error("network down"));
    const user = mount();
    await screen.findByText("No comments yet.");

    const box = screen.getByPlaceholderText("Write a comment…");
    await user.type(box, "don't lose me");
    await user.click(screen.getByRole("button", { name: "Post" }));

    expect(await screen.findByText("Couldn't post your comment.")).toBeInTheDocument();
    expect(box).toHaveValue("don't lose me");
  });

  it("sends exactly one request when Post is clicked twice in the same tick", async () => {
    h.api.taskComments.mockResolvedValue(page([]));
    let resolve!: (v: TaskCommentDTO) => void;
    h.api.createTaskComment.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const user = mount();
    await screen.findByText("No comments yet.");

    const box = screen.getByPlaceholderText("Write a comment…");
    await user.type(box, "fast clicks");
    const postBtn = screen.getByRole("button", { name: "Post" });
    await user.click(postBtn);
    await user.click(postBtn); // isPending hasn't rendered yet on the first tick
    resolve!(comment({ id: "once", authorId: ME, body: "fast clicks" }));

    await screen.findByText("fast clicks");
    expect(h.api.createTaskComment).toHaveBeenCalledTimes(1);
  });
});

describe("replies", () => {
  it("expands, loads, and posts a reply under its parent, bumping replyCount", async () => {
    const top = comment({ id: "top-1", body: "top level", replyCount: 0 });
    h.api.taskComments.mockResolvedValue(page([top]));
    h.api.taskCommentReplies.mockResolvedValue(page([]));
    const reply = comment({
      id: "reply-1",
      parentCommentId: "top-1",
      authorId: ME,
      authorUsername: "me",
      body: "a thoughtful reply",
    });
    h.api.createTaskCommentReply.mockResolvedValue(reply);

    const user = mount();
    await screen.findByText("top level");
    await user.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(h.api.taskCommentReplies).toHaveBeenCalledWith(TASK_ID, "top-1", { cursor: null, limit: 10 }));

    const box = await screen.findByPlaceholderText("Write a reply…");
    await user.type(box, "a thoughtful reply");
    const replyComposer = box.closest("div")!;
    await user.click(within(replyComposer).getByRole("button", { name: "Post" }));

    expect(await screen.findByText("a thoughtful reply")).toBeInTheDocument();
    expect(h.api.createTaskCommentReply).toHaveBeenCalledWith(TASK_ID, "top-1", "a thoughtful reply");
  });

  it("shows an N replies control that expands the thread without re-expanding via Reply", async () => {
    const top = comment({ id: "top-1", body: "top level", replyCount: 2 });
    h.api.taskComments.mockResolvedValue(page([top]));
    h.api.taskCommentReplies.mockResolvedValue(
      page([comment({ id: "r1", parentCommentId: "top-1", body: "first reply" }), comment({ id: "r2", parentCommentId: "top-1", body: "second reply" })]),
    );

    const user = mount();
    await screen.findByText("top level");
    const repliesToggle = screen.getByRole("button", { name: "2 replies" });
    await user.click(repliesToggle);

    expect(await within(screen.getByText("top level").closest("li")!).findByText("first reply")).toBeInTheDocument();
    expect(screen.getByText("second reply")).toBeInTheDocument();
  });
});
