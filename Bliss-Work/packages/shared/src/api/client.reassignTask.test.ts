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
});
