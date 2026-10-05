import type { SentAssignee } from "./sentTaskFilter";

export type SentTaskSummaryKind = "pending" | "inProgress" | "completed" | "left" | "ignored" | "missed" | "closed";

export interface SentTaskSummary {
  kind: SentTaskSummaryKind;
  /** Assignees who completed, of all `total`. */
  done: number;
  total: number;
}

const isOpen = (a: SentAssignee) => a.status === "SENT" || a.status === "ACKNOWLEDGED";

/**
 * One status for a whole card, which has one row per assignee. Anyone still on it
 * keeps the task open (nobody has looked yet = pending); once nobody is, a
 * completion wins, then the single outcome everyone shares, else "closed".
 * Judged on the rows it is given, so a filtered card summarises what it shows.
 */
export function summarizeSentTask(assignees: readonly SentAssignee[]): SentTaskSummary {
  const done = assignees.filter((a) => a.status === "COMPLETED").length;
  const total = assignees.length;
  const open = assignees.filter(isOpen);
  if (open.length > 0) return { kind: open.every((a) => a.status === "SENT") && done === 0 ? "pending" : "inProgress", done, total };
  if (done > 0) return { kind: "completed", done, total };
  const first = assignees[0]?.status;
  const shared = first && assignees.every((a) => a.status === first);
  if (shared && (first === "LEFT" || first === "IGNORED" || first === "MISSED")) {
    return { kind: first.toLowerCase() as "left" | "ignored" | "missed", done, total };
  }
  return { kind: "closed", done, total };
}
