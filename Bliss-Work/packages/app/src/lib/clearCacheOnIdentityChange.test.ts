/**
 * The query cache is keyed by nothing that says whose it is, so it has to be
 * emptied when the session changes hands. The SPA signs out with a client-side
 * navigation (no reload), which is why the previous user's chats, tasks and unread
 * counts used to be the next user's first paint.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { UserDTO } from "@taskboard/shared";
import { useSession } from "../store/session";
import { clearCacheOnIdentityChange } from "./clearCacheOnIdentityChange";

const user = (id: string, orgId = "org-1") => ({ id, orgId, displayName: id }) as unknown as UserDTO;
const session = (u: UserDTO) => ({ user: u, accessToken: "t", expiresIn: 300 });

let qc: QueryClient;
let stop: () => void;
const KEY = ["conversations"] as const;
const cached = () => qc.getQueryData(KEY);

beforeEach(() => {
  useSession.getState().clear();
  qc = new QueryClient();
  qc.setQueryData(KEY, ["a private chat"]);
  stop = clearCacheOnIdentityChange(qc);
});
afterEach(() => stop());

describe("clearCacheOnIdentityChange", () => {
  it("empties the cache on sign-out", () => {
    useSession.getState().setSession(session(user("alice")));
    qc.setQueryData(KEY, ["alice's chats"]);

    useSession.getState().clear();

    expect(cached()).toBeUndefined();
  });

  it("empties it when a different user takes the session, with no sign-out in between", () => {
    useSession.getState().setSession(session(user("alice")));
    qc.setQueryData(KEY, ["alice's chats"]);

    useSession.getState().setSession(session(user("bob"))); // e.g. a sibling tab logged in as bob

    expect(cached()).toBeUndefined();
  });

  it("empties it when the same user lands in another org", () => {
    useSession.getState().setSession(session(user("alice", "org-1")));
    qc.setQueryData(KEY, ["org 1's chats"]);

    useSession.getState().setSession(session(user("alice", "org-2")));

    expect(cached()).toBeUndefined();
  });

  it("keeps the cache across a token refresh and a profile edit", () => {
    useSession.getState().setSession(session(user("alice")));
    qc.setQueryData(KEY, ["alice's chats"]);

    useSession.getState().setSession(session(user("alice"))); // refresh: same user, new token
    useSession.getState().setUser({ ...user("alice"), displayName: "Alice A." } as UserDTO);

    expect(cached()).toEqual(["alice's chats"]);
  });

  it("does not clear on the first sign-in, when nothing has been signed in before", () => {
    useSession.getState().setSession(session(user("alice")));

    expect(cached()).toEqual(["a private chat"]);
  });

  it("stops watching once unsubscribed", () => {
    useSession.getState().setSession(session(user("alice")));
    stop();

    useSession.getState().clear();

    expect(cached()).toEqual(["a private chat"]);
  });
});
