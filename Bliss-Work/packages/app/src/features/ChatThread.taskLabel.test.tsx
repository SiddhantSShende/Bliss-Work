/**
 * The permanent, clickable "Task: {title}" label — the per-message
 * replacement for the old top-of-conversation "Discussing task" banner.
 *
 * Covers: renders only on a message actually tagged with a taskId, in the
 * same slot/position as the existing "Forwarded" label; the label is a link
 * to the same "Open task" route the old banner used; and a task whose title
 * can't be resolved (deleted, or inaccessible to this viewer — taskDetail is
 * assignee-scoped) falls back to the bare id rather than hiding the label.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const taskDetail = vi.fn();
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: { taskDetail }, config: { kind: "web" } }) }));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: { user: { id: string; username: string; displayName: string } }) => unknown) =>
    sel({ user: { id: "me", username: "me", displayName: "Me" } }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ChatThread, type ThreadMessage } from "./ChatThread";

const TASK_ID = "11111111-1111-1111-1111-111111111111";

const renderThread = (list: ThreadMessage[]) =>
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ChatThread threadId="t1" messages={list} meId="me" onSend={vi.fn()} showSenderNames />
      </QueryClientProvider>
    </MemoryRouter>,
  );

describe("permanent task label", () => {
  it("renders a clickable Task label, in the forwarded label's slot, only on the tagged message", async () => {
    taskDetail.mockResolvedValue({ title: "GRC" });
    const list: ThreadMessage[] = [
      { id: "m1", senderId: "peer", body: "ordinary message", at: "2026-10-01T09:00:00Z" },
      { id: "m2", senderId: "me", body: "about the review", at: "2026-10-01T09:05:00Z", taskId: TASK_ID },
    ];
    renderThread(list);

    const link = await screen.findByRole("link", { name: /Task: GRC/ });
    expect(link).toHaveAttribute("href", `/app/mail/task/${TASK_ID}`);
    // Same slot as "Forwarded": immediately above the bubble, inside the
    // message's own flex column — not a separate banner anywhere else.
    expect(link.className).toContain("text-[11px]");
    expect(link.className).toContain("mb-0.5");

    // The ordinary message must stay exactly as it was — no label at all.
    const ordinaryBubble = screen.getByText("ordinary message").closest("div.flex.flex-col");
    expect(ordinaryBubble?.querySelector("a")).toBeNull();
  });

  it("falls back to the bare task id when the title can't be resolved (deleted or inaccessible task)", async () => {
    taskDetail.mockRejectedValue(new Error("not found"));
    const list: ThreadMessage[] = [
      { id: "m1", senderId: "me", body: "about a task I can't see", at: "2026-10-01T09:00:00Z", taskId: TASK_ID },
    ];
    renderThread(list);

    const link = await waitFor(() => screen.getByRole("link", { name: new RegExp(`Task: ${TASK_ID}`) }));
    expect(link).toHaveAttribute("href", `/app/mail/task/${TASK_ID}`);
  });

  it("renders no task label at all when no message carries a taskId", () => {
    const list: ThreadMessage[] = [{ id: "m1", senderId: "peer", body: "just chatting", at: "2026-10-01T09:00:00Z" }];
    renderThread(list);
    expect(screen.queryByRole("link", { name: /Task:/ })).not.toBeInTheDocument();
  });
});
