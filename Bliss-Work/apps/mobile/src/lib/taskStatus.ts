import type { AssigneeStatus } from '@taskboard/shared';

/** What each assignee status is called in the UI — shared by the Tasks list and Home's Recent Tasks. */
export const STATUS_LABEL: Record<AssigneeStatus, string> = {
  SENT: 'Awaiting response',
  ACKNOWLEDGED: 'In progress',
  COMPLETED: 'Completed',
  IGNORED: 'Ignored',
  LEFT: 'Left',
  MISSED: 'Missed',
};
