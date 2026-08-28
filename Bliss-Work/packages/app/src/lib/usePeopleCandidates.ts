import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRuntime } from "./runtime";
import { useSession } from "../store/session";
import { qk } from "./queryBridge";
import { matchUser } from "./matchUser";

/**
 * The org directory, minus the caller and any caller-supplied exclusions,
 * filtered by a live search query. Every people-picker in the app (call
 * invitees, channel members, task assignees) is built on this.
 *
 * Centralised specifically so "never offer the caller as a pick target" can't
 * be forgotten by a future copy-paste: CreateTaskDialog once reimplemented
 * this filter without the self-exclusion, which let a task be assigned to its
 * own sender — nothing server-side rejected it either. Routing every picker
 * through one hook makes that class of bug structurally impossible to
 * reintroduce.
 *
 * `includeSelf` is the one deliberate opt-out: task assignment allows sending
 * a task to yourself (task-svc's create_task no longer rejects it, matching
 * the channel-fan-out path, where the sender being a member was already
 * fine). It defaults to false so every OTHER picker built on this hook — call
 * invitees, channel members, reviewers — keeps excluding the caller without
 * having to opt back in.
 */
export function usePeopleCandidates(q: string, exclude?: Set<string>, includeSelf = false) {
  const { api } = useRuntime();
  const me = useSession((s) => s.user)!;
  const { data: users = [], isLoading } = useQuery({
    queryKey: qk.directory,
    queryFn: () => api.directory(),
  });
  // Self/exclude-filtered but NOT search-filtered — the pool a "select
  // everyone" action targets, since a search term shouldn't silently shrink
  // what "everyone" means.
  const all = users.filter((u) => (includeSelf || u.id !== me.id) && !exclude?.has(u.id));
  const candidates = all.filter((u) => matchUser(u, q));
  return { all, candidates, isLoading, me };
}

/** Search-box state paired with usePeopleCandidates, for callers that don't
 *  already own a `q` elsewhere (most pickers). */
export function usePeopleSearch(exclude?: Set<string>, includeSelf = false) {
  const [q, setQ] = useState("");
  const { all, candidates, isLoading, me } = usePeopleCandidates(q, exclude, includeSelf);
  return { q, setQ, all, candidates, isLoading, me };
}
