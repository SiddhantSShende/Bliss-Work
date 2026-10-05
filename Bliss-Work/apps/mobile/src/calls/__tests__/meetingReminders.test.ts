jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('expo-notifications', () => ({}));

import type { CallDTO } from '@taskboard/shared';
import { REMINDER_LEAD_MS, diffReminders, planReminders, reminderBody, reminderId } from '../meetingReminders';

const now = Date.parse('2026-09-28T15:00:00Z');
const call = (id: string, over: Partial<CallDTO> = {}): CallDTO =>
  ({
    id,
    orgId: 'o',
    kind: 'MEETING',
    title: 'Team Meeting',
    media: 'video',
    createdBy: 'u',
    createdAt: '2026-09-28T14:00:00Z',
    status: 'SCHEDULED',
    scheduledAt: '2026-09-28T16:00:00Z',
    participants: [],
    activeShares: [],
    ...over,
  }) as CallDTO;

describe('planReminders', () => {
  it('plans one reminder exactly 10 minutes before the start', () => {
    const [r] = planReminders([call('a')], now);
    expect(r!.fireAt).toBe(Date.parse('2026-09-28T15:50:00Z'));
    expect(r!.fireAt).toBe(r!.startsAt - REMINDER_LEAD_MS);
    expect(r!.id).toBe(reminderId('a', r!.startsAt));
  });
  it('skips cancelled, ended, live and open-ended ("meet now") calls', () => {
    const calls = [call('c', { status: 'CANCELLED' }), call('e', { status: 'ENDED' }), call('l', { status: 'LIVE' }), call('n', { scheduledAt: null })];
    expect(planReminders(calls, now)).toEqual([]);
  });
  it('skips a meeting whose 10-minute mark has already passed', () => {
    expect(planReminders([call('a', { scheduledAt: '2026-09-28T15:06:00Z' })], now)).toEqual([]);
  });
  it('gives a rescheduled meeting a different id, so the old reminder is invalidated', () => {
    const old = planReminders([call('a')], now)[0]!;
    const moved = planReminders([call('a', { scheduledAt: '2026-09-28T17:00:00Z' })], now)[0]!;
    expect(moved.id).not.toBe(old.id);
    expect(moved.fireAt).toBe(Date.parse('2026-09-28T16:50:00Z'));
    const d = diffReminders([moved], [old.id]);
    expect(d.toCancel).toEqual([old.id]);
    expect(d.toSchedule).toEqual([moved]);
  });
  it('caps how many are pending (iOS allows 64 in total)', () => {
    const many = Array.from({ length: 100 }, (_, i) => call(`m${i}`, { scheduledAt: new Date(now + (20 + i) * 60_000).toISOString() }));
    expect(planReminders(many, now)).toHaveLength(48);
  });
});

describe('diffReminders', () => {
  it('is a no-op when the pending set already matches (no duplicate reminder)', () => {
    const planned = planReminders([call('a')], now);
    expect(diffReminders(planned, planned.map((p) => p.id))).toEqual({ toCancel: [], toSchedule: [] });
  });
  it('cancels a reminder whose meeting is gone, and never touches unrelated notifications', () => {
    const gone = reminderId('deleted', now + 3_600_000);
    const d = diffReminders([], [gone, 'call-abc', 'something-else']);
    expect(d.toCancel).toEqual([gone]);
  });
});

describe('reminderBody', () => {
  it('names the meeting', () => expect(reminderBody('Team Meeting')).toBe('Team Meeting starts in 10 minutes.'));
  it('copes with an untitled meeting', () => expect(reminderBody('  ')).toBe('Your meeting starts in 10 minutes.'));
});
