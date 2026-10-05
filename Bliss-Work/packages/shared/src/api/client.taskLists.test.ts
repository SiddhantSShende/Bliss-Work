/**
 * /tasks/inbox, /tasks/assigned and /tasks/sticky serve at most 100 rows a page
 * (50 unless asked). The client read only the first page, so a user with more open
 * tasks than that silently lost the rest — and the desktop's sticky refresh
 * unpinned any task that fell off page one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const row = (n: number) => ({
  taskId: uuid(n),
  orgId: uuid(9999),
  title: `Task ${n}`,
  description: "",
  senderId: uuid(8888),
  senderUsername: "sender",
  myStatus: "SENT",
  actions: ["ACKNOWLEDGE", "IGNORE"],
  statusVersion: 0,
  assignedAt: "2026-09-01T10:00:00.000Z",
  acknowledgedAt: null,
  reviewRating: null,
});

/** Serves `total` rows, honouring limit/offset the way task-svc does (limit capped at 100). */
function serve(total: number) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const q = new URL(url, "http://x").searchParams;
      const limit = Math.min(Number(q.get("limit") ?? 50), 100);
      const offset = Number(q.get("offset") ?? 0);
      const rows = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => row(offset + i));
      return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const client = () => new ApiClient({ taskBase: "http://tasks.test", getToken: async () => "t" } as never);

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe.each([
  ["taskInbox", "/api/v1/tasks/inbox"],
  ["taskAssigned", "/api/v1/tasks/assigned"],
  ["tasksSticky", "/api/v1/tasks/sticky"],
] as const)("%s", (method, path) => {
  it("returns every row of a list longer than one page, once each and in order", async () => {
    serve(250);

    const rows = await client()[method]();

    expect(rows).toHaveLength(250);
    expect(rows.map((r) => r.taskId)).toEqual(Array.from({ length: 250 }, (_, i) => uuid(i)));
  });

  it("makes a single request for a short list", async () => {
    const calls = serve(7);

    const rows = await client()[method]();

    expect(rows).toHaveLength(7);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`${path}?limit=100&offset=0`);
  });

  it("still asks for another page when a page is exactly full, and stops on the empty one", async () => {
    const calls = serve(100);

    const rows = await client()[method]();

    expect(rows).toHaveLength(100);
    expect(calls).toHaveLength(2);
  });

  it("is bounded: an endless list is cut off rather than fetched forever", async () => {
    const calls = serve(1_000_000);

    const rows = await client()[method]();

    expect(calls).toHaveLength(20);
    expect(rows).toHaveLength(2000);
  });
});
