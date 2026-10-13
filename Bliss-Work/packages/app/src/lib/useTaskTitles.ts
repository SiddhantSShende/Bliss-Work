import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { AssigneeStatus } from "@taskboard/shared";
import { useRuntime } from "./runtime";

/** What a message's task-reference card needs, resolved per distinct task
 *  id — not per message (see useTaskCards). */
export interface TaskCardInfo {
  title: string;
  myStatus: AssigneeStatus;
  deadlineAt: string | null;
  /** Other participants' user ids, for the card's "Assignees" line — resolve
   *  display names with useUserLabels, same as everywhere else a user id is
   *  shown (see that hook's docstring on why the directory, not this DTO's
   *  own `username`, is the source of a real name). */
  participantIds: string[];
  /** True when taskDetail 404'd/403'd for THIS viewer — the task was
   *  deleted, or access was revoked since it was shared. The card should
   *  render a graceful "Task unavailable" state rather than nothing. */
  unavailable: boolean;
}

/**
 * Task-reference cards for the distinct task ids a conversation's messages
 * carry, one lookup per id — not per message. Keyed `["taskDetail", id]`,
 * the same query key DMView/ChannelView already use for the focused task's
 * own title, so the common case (the currently task-focused conversation)
 * hits a warm cache instead of refetching.
 *
 * taskDetail is assignee-scoped (services/task-svc/app/routes/tasks_read.py)
 * and 404s for anyone else — an allocator or an uninvolved channel member
 * included. For a self-chat task-share this can still happen AFTER the
 * fact: the sharer loses access (reassigned, removed) between sharing it
 * and reopening Notes to Self. That is `unavailable`, not an error to
 * surface — see ChatThread's rendering.
 */
export function useTaskCards(taskIds: Iterable<string>): Map<string, TaskCardInfo> {
  const { api } = useRuntime();
  const ids = [...new Set(taskIds)];
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["taskDetail", id],
      queryFn: () => api.taskDetail(id),
      retry: false,
    })),
  });
  const key =
    results.map((r) => `${r.data?.title ?? ""}|${r.data?.myStatus ?? ""}|${r.isError}`).join(",") + ids.join(",");
  return useMemo(() => {
    const out = new Map<string, TaskCardInfo>();
    results.forEach((r, i) => {
      if (r.data) {
        out.set(ids[i]!, {
          title: r.data.title,
          myStatus: r.data.myStatus ?? "SENT",
          deadlineAt: r.data.deadlineAt ?? null,
          participantIds: (r.data.participants ?? []).map((p) => p.userId),
          unavailable: false,
        });
      } else if (r.isError) {
        out.set(ids[i]!, {
          title: "",
          myStatus: "SENT",
          deadlineAt: null,
          participantIds: [],
          unavailable: true,
        });
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on `key`, see above
  }, [key]);
}
