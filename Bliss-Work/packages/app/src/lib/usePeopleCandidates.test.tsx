/**
 * Regression guard for the self-assignment bug: CreateTaskDialog once listed
 * the org directory without excluding the caller, so a task could be assigned
 * to its own sender — nothing server-side rejected it either (see task-svc's
 * tasks_write.py). Every people-picker in the app is now built on this hook
 * specifically so that filter can't be dropped again by a future copy-paste.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { UserDTO } from "@taskboard/shared";
import { usePeopleCandidates, usePeopleSearch } from "./usePeopleCandidates";
import { useSession } from "../store/session";

const ME = { id: "11111111-1111-1111-1111-111111111111", username: "alice", displayName: "Alice", email: "alice@example.com" } as UserDTO;
const BOB = { id: "22222222-2222-2222-2222-222222222222", username: "bob", displayName: "Bob", email: "bob@example.com" } as UserDTO;
const CARL = { id: "33333333-3333-3333-3333-333333333333", username: "carl", displayName: "Carl", email: "carl@example.com" } as UserDTO;
const directory = [ME, BOB, CARL];

vi.mock("./runtime", () => ({
  useRuntime: () => ({ api: { directory: () => Promise.resolve(directory) } }),
}));
vi.mock("./queryBridge", () => ({ qk: { directory: ["directory"] } }));
vi.mock("@tanstack/react-query", () => ({
  // The hook only reads {data, isLoading} off useQuery's result — a
  // synchronous stand-in keeps the test free of act()/waitFor plumbing while
  // still exercising the hook's own filtering logic for real.
  useQuery: () => ({ data: directory, isLoading: false }),
}));

beforeEach(() => {
  useSession.getState().setSession({ user: ME, accessToken: "at", expiresIn: 900 });
});

describe("usePeopleCandidates", () => {
  it("never offers the caller as a candidate, searched or not", () => {
    const { result } = renderHook(() => usePeopleCandidates(""));
    expect(result.current.candidates.map((u) => u.id)).not.toContain(ME.id);
    expect(result.current.all.map((u) => u.id)).not.toContain(ME.id);
  });

  it("excludes the caller even when a search query would otherwise match them", () => {
    const { result } = renderHook(() => usePeopleCandidates("alice"));
    expect(result.current.candidates).toHaveLength(0);
  });

  it("excludes the caller even when the exclude set is empty", () => {
    const { result } = renderHook(() => usePeopleCandidates("", new Set<string>()));
    expect(result.current.candidates.map((u) => u.id)).not.toContain(ME.id);
  });

  it("still applies caller-supplied exclusions alongside the self-exclusion", () => {
    const { result } = renderHook(() => usePeopleCandidates("", new Set([BOB.id])));
    expect(result.current.candidates.map((u) => u.id)).toEqual([CARL.id]);
  });
});

describe("usePeopleSearch", () => {
  it("owns its own query state and still excludes the caller", () => {
    const { result } = renderHook(() => usePeopleSearch());
    expect(result.current.candidates.map((u) => u.id)).toEqual([BOB.id, CARL.id]);
  });
});
