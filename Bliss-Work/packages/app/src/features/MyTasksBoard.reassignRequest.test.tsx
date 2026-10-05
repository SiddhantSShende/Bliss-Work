/**
 * The Reassign button through the REAL ApiClient: only the network is stubbed, so
 * what is asserted is the request the browser would actually send — method, URL,
 * auth, no body — and what the board does with the answer. (MyTasksBoard.reassign.test
 * replaces the whole `api` object and so cannot see the request.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, type SentTaskDTO } from "@taskboard/shared";
import { toast } from "sonner";
import { useSession } from "../store/session";

const TASK = "11111111-1111-4111-8111-111111111111";
const AT = "2026-09-19T10:00:00.000Z";
const sent = (status: string) =>
  [
    {
      taskId: TASK,
      title: "Ship it",
      description: "",
      createdAt: AT,
      participants: [],
      assignees: [{ assigneeId: "u-alice", assigneeUsername: "alice", status, assignedAt: AT }],
    },
  ] as unknown as SentTaskDTO[];

// The browser's base is the edge mount, exactly as in .env.prod.example.
const api = new ApiClient({ taskBase: "/api/tasks", getToken: async () => "tok" } as never);
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { MyTasksBoard } from "./MyTasksBoard";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const reassignCalls = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.filter(([u]) => String(u).endsWith("/reassign")) as unknown as [string, RequestInit][];

beforeEach(() => {
  vi.clearAllMocks();
  useSession.setState({ user: { id: "me" } } as never);
  // The reads are not what is under test; reassign is real.
  vi.spyOn(api, "tasksSent").mockResolvedValue(sent("COMPLETED"));
  vi.spyOn(api, "directory").mockResolvedValue([] as never);
  vi.spyOn(api, "taskSchedules").mockResolvedValue([] as never);
  vi.spyOn(api, "channels").mockResolvedValue([] as never);
});
afterEach(() => vi.unstubAllGlobals());

function renderBoard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MyTasksBoard />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

describe("Reassign button → ApiClient → network", () => {
  it("sends one authenticated body-less POST to the task's reassign path under the edge mount, and the card reopens", async () => {
    const fetchStub = vi.fn(async () => json(200, { taskId: TASK, reassignedUserIds: ["u-alice"] }));
    vi.stubGlobal("fetch", fetchStub);
    const user = renderBoard();
    await screen.findByText("Ship it");
    // What the server answers once the reassignment has gone through.
    vi.mocked(api.tasksSent).mockResolvedValue(sent("SENT"));

    await user.click(screen.getByRole("button", { name: /^Reassign/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Task sent back to 1 person"));
    const calls = reassignCalls(fetchStub);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(url).toBe(`/api/tasks/api/v1/tasks/${TASK}/reassign`);
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Reassign/ })).not.toBeInTheDocument());
  });

  it("when the server has no such route (404) it says so and leaves the card Completed with Reassign available", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(404, { detail: "Not Found" })));
    const user = renderBoard();
    await screen.findByText("Ship it");

    await user.click(screen.getByRole("button", { name: /^Reassign/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't reassign this task", expect.anything()));
    expect(toast.success).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Reassign/ })).toBeEnabled());
  });
});
