import { useQuery } from "@tanstack/react-query";
import type { UserDTO } from "@taskboard/shared";
import { useRuntime } from "./runtime";
import { useSession } from "../store/session";
import { qk } from "./queryBridge";

export type AvailablePerson = {
  user: UserDTO;
  /** Unacknowledged allocations. A hint only — does NOT consume availability. */
  pending: number;
  hidden: boolean;
};

/**
 * Joins the auth-svc org directory against task-svc's open-workload counts to
 * answer "who is free right now".
 *
 * Available = ZERO ACKNOWLEDGED assignments. Someone holding only SENT (not yet
 * acknowledged), terminal (COMPLETED / IGNORED / LEFT), or no tasks at all is
 * available — an allocation nobody has picked up isn't committed work.
 *
 * The member list comes from the DIRECTORY, not from task-svc: that service's
 * user_projection is a partial `user.created`-only mirror. A user absent from
 * the counts map is 0/0, which is exactly right for a new hire.
 *
 * The 30s poll is the ONLY org-wide freshness mechanism: task.* events route to
 * the sender + assignee only (ws-gateway contract.RecipientsOf), so a third
 * member watching this pane gets no push. The WsEventBridge invalidations are an
 * instant-feedback optimization for the two parties, not the correctness story.
 */
export function useAvailability() {
  const { api } = useRuntime();
  const me = useSession((s) => s.user)!;
  const { data: users = [] } = useQuery({ queryKey: qk.directory, queryFn: () => api.directory() });
  const { data, isLoading } = useQuery({
    queryKey: qk.availability,
    queryFn: () => api.taskAvailability(),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const byUser = new Map((data?.counts ?? []).map((c) => [c.userId, c]));
  const hiddenSet = new Set(data?.hiddenUserIds ?? []);
  const ackedOf = (id: string) => byUser.get(id)?.acknowledged ?? 0;
  const toPerson = (u: UserDTO): AvailablePerson => ({
    user: u,
    pending: byUser.get(u.id)?.pending ?? 0,
    hidden: hiddenSet.has(u.id),
  });

  const free = users.filter((u) => ackedOf(u.id) === 0).map(toPerson);

  return {
    /** The roster everyone sees: unhidden free people, PLUS your own card even
     *  when you're hidden — badged in the UI so you know why nobody is
     *  allocating to you. */
    roster: free.filter((p) => !p.hidden || p.user.id === me.id),
    /** Hidden AND free — the admin-only section. */
    hidden: free.filter((p) => p.hidden && p.user.id !== me.id),
    /** Hidden AND busy. Without this an admin who hides someone who then picks
     *  up work could never un-hide them: they'd be absent from both lists. */
    hiddenBusy: users
      .filter((u) => hiddenSet.has(u.id) && ackedOf(u.id) > 0 && u.id !== me.id)
      .map(toPerson),
    /** True when I'm free but an admin hid me — drives the self badge. */
    hiddenSelf: hiddenSet.has(me.id),
    canManage: data?.canManage ?? false,
    isLoading,
  };
}
