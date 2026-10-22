import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionsFor, type StickyTaskDTO, type TaskCommentDTO, type TaskCommentPage } from "@taskboard/shared";

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

import { StickyWidget } from "./StickyWidget";

const TASK_ID = "11111111-1111-1111-1111-111111111111";
const TASK: StickyTaskDTO = {
  taskId: TASK_ID,
  orgId: "22222222-2222-2222-2222-222222222222",
  title: "Write a report",
  description: "",
  senderId: "33333333-3333-3333-3333-333333333333",
  senderUsername: "sender",
  myStatus: "SENT",
  actions: actionsFor("SENT"),
  statusVersion: 1,
  participants: [],
  assignedAt: "2026-10-22T00:00:00.000Z",
  acknowledgedAt: null,
};

function page(comments: TaskCommentDTO[] = []): TaskCommentPage {
  return { comments, hasMore: false, nextCursor: null };
}

beforeEach(() => {
  h.api.taskComments.mockReset().mockResolvedValue(page());
  h.api.createTaskComment.mockReset();
  h.api.taskCommentReplies.mockReset().mockResolvedValue(page());
  h.api.createTaskCommentReply.mockReset();
});

afterEach(() => cleanup());

describe("desktop pin Comments input", () => {
  it("focuses, accepts edits, and submits through the existing task-comments API", async () => {
    const user = userEvent.setup();
    const posted: TaskCommentDTO = {
      id: "comment-1",
      taskId: TASK_ID,
      parentCommentId: null,
      authorId: "44444444-4444-4444-4444-444444444444",
      authorUsername: "me",
      authorDisplayName: "Me",
      body: "pin comment",
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:00:00.000Z",
      replyCount: 0,
    };
    h.api.createTaskComment.mockResolvedValue(posted);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <StickyWidget task={TASK} onAction={vi.fn()} compact />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Comments" }));

    const input = await screen.findByPlaceholderText("Write a comment…");
    expect(input).toHaveClass("app-no-drag");
    await user.click(input);
    expect(document.activeElement).toBe(input);
    await user.type(input, "pin comment");
    expect(input).toHaveValue("pin comment");
    await user.keyboard("{ArrowLeft}{Backspace}");
    expect(input).toHaveValue("pin commet");
    await user.keyboard("{Control>}a{/Control}pin comment");
    expect(input).toHaveValue("pin comment");

    await user.click(screen.getByRole("button", { name: "Post" }));
    expect(await screen.findByText("pin comment")).toBeInTheDocument();
    expect(h.api.createTaskComment).toHaveBeenCalledWith(TASK_ID, "pin comment");
    await waitFor(() => expect(input).toHaveValue(""));
  });
});
