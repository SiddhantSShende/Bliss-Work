/**
 * reassignTask: a body-less authenticated POST to the task's own path. The server
 * restores the previous assignees itself, so nothing here may name anyone — a caller
 * cannot use this to choose who gets the task back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";

const TASK = "11111111-1111-4111-8111-111111111111";
const client = () => new ApiClient({ taskBase: "http://task.test", getToken: async () => "tok" } as never);

afterEach(() => vi.unstubAllGlobals());

describe("reassignTask", () => {
  it("POSTs to /tasks/{id}/reassign with the bearer token and no body, and parses who was restored", async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify({ taskId: TASK, reassignedUserIds: ["u1", "u2"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchStub);

    await expect(client().reassignTask(TASK)).resolves.toEqual({ taskId: TASK, reassignedUserIds: ["u1", "u2"] });

    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://task.test/api/v1/tasks/${TASK}/reassign`);
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
  });

  it("surfaces the server's refusal with its status and message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "forbidden", message: "only the allocator can reassign a task" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const err = await client().reassignTask(TASK).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, message: "only the allocator can reassign a task" });
  });

  it("goes to /api/tasks/api/v1/tasks/{id}/reassign behind the edge, which Caddy strips to /api/v1/tasks/{id}/reassign", async () => {
    // The browser's taskBase is the edge's /api/tasks mount, so the Network tab shows
    // /api/tasks/api/v1/... — that doubled "api" is correct, not a prefix bug. Caddy's
    // handle_path removes /api/tasks and task-svc serves /api/v1/tasks/{id}/reassign.
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify({ taskId: TASK, reassignedUserIds: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchStub);
    const edge = new ApiClient({ taskBase: "/api/tasks", getToken: async () => "tok" } as never);

    await edge.reassignTask(TASK);

    const [url] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/tasks/api/v1/tasks/${TASK}/reassign`);
    expect(url.replace(/^\/api\/tasks/, "")).toBe(`/api/v1/tasks/${TASK}/reassign`);
  });

  it("reports a task-svc build that has no such route (FastAPI's bare 404) as a 404, not a success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } })),
    );

    const err = await client().reassignTask(TASK).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404 });
  });
});
