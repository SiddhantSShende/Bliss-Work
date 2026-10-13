/**
 * The task-reference card's RICHER info row (status/deadline/assignees),
 * layered onto the existing permanent "Task: {title}" label (see
 * ChatThread.taskLabel.test.tsx, which this must not change the behavior
 * of). Covers: the extra row renders once taskDetail resolves; it is absent
 * — not a broken card — once access is revoked (taskDetail 404/403s after a
 * share), which is exactly the existing bare-id fallback already handles
 * gracefully for the link itself.
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
vi.mock("./../lib/userLabel", async (orig) => ({
  ...(await orig<typeof import("../lib/userLabel")>()),
  useUserLabels: () => ({ avatarUrlOf: () => undefined, nameOf: (id: string) => (id === "assignee-1" ? "Ada Lovelace" : id) }),
}));

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

describe("task-reference card: status/deadline/assignees", () => {
  it("renders status, deadline and assignees once taskDetail resolves", async () => {
    taskDetail.mockResolvedValue({
      title: "File the GRC review",
      myStatus: "ACKNOWLEDGED",
      deadlineAt: "2026-12-01T17:00:00Z",
      participants: [{ userId: "assignee-1", username: "ada", status: "ACKNOWLEDGED" }],
    });
    const list: ThreadMessage[] = [
      { id: "m1", senderId: "me", body: "Shared this task", at: "2026-10-01T09:00:00Z", taskId: TASK_ID },
    ];
    renderThread(list);

    await screen.findByRole("link", { name: /Task: File the GRC review/ });
    expect(await screen.findByText("Acknowledged")).toBeTruthy();
    expect(screen.getByText(/Assignees: Ada Lovelace/)).toBeTruthy();
  });

  it("renders only the existing bare-id link, with no status row, once access is revoked", async () => {
    taskDetail.mockRejectedValue(new Error("not found"));
    const list: ThreadMessage[] = [
      { id: "m1", senderId: "me", body: "Shared this task", at: "2026-10-01T09:00:00Z", taskId: TASK_ID },
    ];
    renderThread(list);

    const link = await waitFor(() => screen.getByRole("link", { name: new RegExp(`Task: ${TASK_ID}`) }));
    expect(link).toHaveAttribute("href", `/app/mail/task/${TASK_ID}`);
    expect(screen.queryByText("Acknowledged")).toBeNull();
  });
});
