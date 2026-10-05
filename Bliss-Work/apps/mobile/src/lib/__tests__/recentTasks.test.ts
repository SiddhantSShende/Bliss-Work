import type { StickyTaskDTO } from '@taskboard/shared';
import { RECENT_TASKS_LIMIT, recentTasks } from '../recentTasks';

const task = (id: string, assignedAt: string, over: Partial<StickyTaskDTO> = {}): StickyTaskDTO => ({
  taskId: id,
  orgId: 'o',
  title: `Task ${id}`,
  description: '',
  senderId: 's',
  senderUsername: 'sender',
  myStatus: 'SENT',
  actions: [],
  statusVersion: 1,
  assignedAt,
  acknowledgedAt: null,
  ...over,
});
const ids = (l: StickyTaskDTO[]) => l.map((t) => t.taskId);

describe('recentTasks', () => {
  it('shows the five most recently assigned, newest first', () => {
    const list = [1, 2, 3, 4, 5, 6, 7].map((n) => task(`t${n}`, `2026-09-0${n}T10:00:00Z`));
    expect(ids(recentTasks(list))).toEqual(['t7', 't6', 't5', 't4', 't3']);
    expect(RECENT_TASKS_LIMIT).toBe(5);
  });
  it('orders correctly whatever order the API returns', () => {
    const list = [task('b', '2026-09-02T10:00:00Z'), task('c', '2026-09-03T10:00:00Z'), task('a', '2026-09-01T10:00:00Z')];
    expect(ids(recentTasks(list))).toEqual(['c', 'b', 'a']);
  });
  it('compares real instants, not strings (different offsets, and the same day by time)', () => {
    const list = [task('early', '2026-09-01T23:00:00-05:00'), task('late', '2026-09-02T02:00:00Z'), task('mid', '2026-09-02T05:00:00+05:00')];
    // early = 09-02 04:00Z, late = 09-02 02:00Z, mid = 09-02 00:00Z
    expect(ids(recentTasks(list))).toEqual(['early', 'late', 'mid']);
  });
  it('returns only what exists when there are fewer than five — no padding', () => {
    expect(recentTasks([task('a', '2026-09-01T10:00:00Z')])).toHaveLength(1);
    expect(recentTasks([])).toEqual([]);
    expect(recentTasks(undefined)).toEqual([]);
  });
  it('does not treat acknowledging or completing a task as making it new again', () => {
    const list = [
      task('old', '2026-09-01T10:00:00Z', { myStatus: 'COMPLETED', completedAt: '2026-09-30T10:00:00Z', acknowledgedAt: '2026-09-29T10:00:00Z' }),
      task('new', '2026-09-10T10:00:00Z'),
    ];
    expect(ids(recentTasks(list))).toEqual(['new', 'old']);
  });
  it('puts a task with an unreadable timestamp last and keeps ties stable', () => {
    const list = [task('bad', 'not-a-date'), task('x', '2026-09-05T10:00:00Z'), task('y', '2026-09-05T10:00:00Z')];
    expect(ids(recentTasks(list))).toEqual(['x', 'y', 'bad']);
  });
  it('never lists a task id twice', () => {
    const list = [task('a', '2026-09-01T10:00:00Z'), task('a', '2026-09-02T10:00:00Z'), task('b', '2026-09-03T10:00:00Z')];
    expect(ids(recentTasks(list))).toEqual(['b', 'a']);
  });
  it('does not mutate its input', () => {
    const list = [task('a', '2026-09-01T10:00:00Z'), task('b', '2026-09-03T10:00:00Z')];
    recentTasks(list);
    expect(ids(list)).toEqual(['a', 'b']);
  });
});
