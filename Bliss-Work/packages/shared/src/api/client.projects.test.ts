import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";

const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const project = (n: number) => ({ id: uuid(n), name: `Project ${n}`, channelId: uuid(n + 10_000) });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const client = () => new ApiClient({ taskBase: "http://task.test", getToken: async () => "tok" } as never);

afterEach(() => vi.unstubAllGlobals());

describe("project API", () => {
  it("fetches all projects across bounded pages", async () => {
    const first = Array.from({ length: 100 }, (_, index) => project(index + 1));
    const fetchStub = vi.fn(async (url: string) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      return json(offset === 0 ? first : [project(101)]);
    });
    vi.stubGlobal("fetch", fetchStub);

    const rows = await client().projects();

    expect(rows).toHaveLength(101);
    expect(fetchStub.mock.calls.map(([url]) => new URL(url).search)).toEqual([
      "?limit=100&offset=0",
      "?limit=100&offset=100",
    ]);
  });

  it("constructs the production projects URL from the task service base", async () => {
    const fetchStub = vi.fn(async (_url: string) => json([]));
    vi.stubGlobal("fetch", fetchStub);
    const api = new ApiClient({
      taskBase: "https://communication.rnrtechs.com/api/tasks",
      getToken: async () => "tok",
    } as never);

    await expect(api.projects()).resolves.toEqual([]);
    expect(fetchStub.mock.calls[0]?.[0]).toBe(
      "https://communication.rnrtechs.com/api/tasks/api/v1/projects?limit=100&offset=0",
    );
  });

  it("reads one project by id", async () => {
    const expected = project(8);
    const fetchStub = vi.fn(async (_url: string) => json(expected));
    vi.stubGlobal("fetch", fetchStub);

    await expect(client().projectDetail(expected.id)).resolves.toEqual(expected);
    expect(fetchStub.mock.calls[0]?.[0]).toBe(`http://task.test/api/v1/projects/${expected.id}`);
  });

  it("URL-encodes project-name lookups and returns null for an expected miss", async () => {
    const expected = project(9);
    const fetchStub = vi.fn(async (url: string) =>
      url.includes("Alpha") ? json(expected) : json({ detail: "Not Found" }, 404),
    );
    vi.stubGlobal("fetch", fetchStub);

    await expect(client().projectByName("Alpha & Beta")).resolves.toEqual(expected);
    expect(fetchStub.mock.calls[0]?.[0]).toBe("http://task.test/api/v1/projects/by-name?name=Alpha+%26+Beta");
    await expect(client().projectByName("Missing")).resolves.toBeNull();
  });

  it("does not hide project lookup failures other than 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => json({ detail: "unavailable" }, 503)));

    const error = await client().projectByName("Alpha").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503 });
  });
});
